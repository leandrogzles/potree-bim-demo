import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import dotenv from 'dotenv';
import multer from 'multer';

import { downloadDerivatives, fetchManifest, analyzeManifest } from './aps/derivative';
import { ensureSvf1Derivative, startTranslation, getTranslationStatus } from './aps/translate';
import type { OutputFormat } from './aps/translate';
import { convertFromDerivativeService, checkSvfAvailable } from './convert/forgeConvert';
import { convertIfcToGlb, listIfcModels } from './convert/ifcToGlb';
import { isLocked, getActiveLocks } from './convert/lock';
import { createJob, updateJob, getJob, getAllJobs } from './jobs/jobStore';
import { sanitizeUrn } from './utils/pathSafe';
import { listBuckets, listBucketObjects, getAllBucketObjects, getObjectUrn, getObjectDetails } from './aps/bucket';
import {
  listPointClouds,
  ensurePotreePointCloud,
  findRawFileById,
  findRawFileByName,
} from './pointcloud/convertRawToPotree';

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || './data/downloads';
const CONVERTED_DIR = process.env.CONVERTED_DIR || './data/converted';
const CONVERTED_IFC_DIR = process.env.CONVERTED_IFC_DIR || './data/converted-ifc';
const IFC_DIR = process.env.IFC_DIR || './data/ifc';
const POINTCLOUD_DIR = process.env.POINTCLOUD_DIR || './data/pointclouds';
const POINTCLOUD_RAW_DIR = process.env.POINTCLOUD_RAW_DIR || './data/pointclouds_raw';
const POINTCLOUD_CACHE_DIR = process.env.POINTCLOUD_CACHE_DIR || './data/pointclouds_cache';
const ALIGNMENT_DIR = process.env.ALIGNMENT_DIR || './data/alignment';

const ifcStorage = multer.diskStorage({
  destination: async (req, _file, cb) => {
    const ifcId = req.body.ifcId || uuidv4();
    req.body.ifcId = ifcId;
    const destDir = path.join(IFC_DIR, ifcId);
    await fs.promises.mkdir(destDir, { recursive: true });
    cb(null, destDir);
  },
  filename: (_req, _file, cb) => {
    cb(null, 'model.ifc');
  },
});

const uploadIfc = multer({
  storage: ifcStorage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.originalname.toLowerCase().endsWith('.ifc') ||
        file.mimetype === 'application/x-step' ||
        file.mimetype === 'application/octet-stream') {
      cb(null, true);
    } else {
      cb(new Error('Only IFC files are allowed'));
    }
  },
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const DownloadRequestSchema = z.object({
  urn: z.string().min(1, 'URN is required'),
  prefer: z.enum(['svf', 'svf2', 'auto']).default('auto'),
  autoGenerateSvf: z.boolean().default(false),
});

const ConvertRequestSchema = z.object({
  urn: z.string().min(1, 'URN is required'),
  viewName: z.string().optional(),
  outputName: z.string().default('model.glb'),
  quality: z.enum(['fast', 'balanced', 'small']).default('balanced'),
});

const AlignmentSchema = z.object({
  urn: z.string().min(1, 'URN is required'),
  matrix: z
    .array(z.number().finite())
    .length(16, 'Matrix must have exactly 16 numbers'),
  units: z.enum(['m', 'mm', 'cm', 'ft', 'in']).default('m'),
});

const TranslateRequestSchema = z.object({
  urn: z.string().min(1, 'URN is required'),
  outputFormat: z.enum(['svf', 'svf2', 'thumbnail', 'stl', 'step', 'iges', 'obj']).default('svf'),
  outputFormats: z.array(z.enum(['svf', 'svf2', 'thumbnail', 'stl', 'step', 'iges', 'obj'])).optional(),
  views: z.array(z.enum(['2d', '3d'])).default(['2d', '3d']),
  rootFilename: z.string().optional(),
  compressedUrn: z.boolean().default(false),
});

const IfcEnsureGlbSchema = z.object({
  ifcId: z.string().min(1, 'IFC ID is required'),
  quality: z.enum(['fast', 'balanced', 'small']).default('balanced'),
  skipOptimization: z.boolean().default(false),
});

const AlignmentByModelIdSchema = z.object({
  modelId: z.string().min(1, 'Model ID is required'),
  matrix: z
    .array(z.number().finite())
    .length(16, 'Matrix must have exactly 16 numbers'),
  units: z.enum(['m', 'mm', 'cm', 'ft', 'in']).default('m'),
});

const EnsurePointCloudSchema = z.object({
  id: z.string().optional(),
  rawFileName: z.string().optional(),
}).refine(data => data.id || data.rawFileName, {
  message: 'Either id or rawFileName is required',
});

async function ensureDir(dir: string): Promise<void> {
  try {
    await fs.promises.mkdir(dir, { recursive: true });
  } catch {
    // ignore if exists
  }
}

function getIdentityMatrix(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    activeConversions: getActiveLocks(),
  });
});

app.get('/api/buckets', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const buckets = await listBuckets();
    res.json({
      buckets: buckets.map((b) => ({
        bucketKey: b.bucketKey,
        createdDate: new Date(b.createdDate).toISOString(),
        policyKey: b.policyKey,
      })),
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/buckets/:bucketKey/objects', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { bucketKey } = req.params;
    const { all, beginsWith } = req.query;

    let objects;
    if (all === 'true') {
      objects = await getAllBucketObjects(bucketKey);
    } else {
      const response = await listBucketObjects(bucketKey, {
        limit: 100,
        beginsWith: beginsWith as string | undefined,
      });
      objects = response.items;
    }

    const enrichedObjects = objects.map((obj) => ({
      objectKey: obj.objectKey,
      objectId: obj.objectId,
      urn: getObjectUrn(obj.objectId),
      size: obj.size,
      sizeFormatted: formatBytes(obj.size),
    }));

    res.json({
      bucketKey,
      count: enrichedObjects.length,
      objects: enrichedObjects,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/buckets/:bucketKey/objects/:objectKey', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { bucketKey, objectKey } = req.params;
    const details = await getObjectDetails(bucketKey, decodeURIComponent(objectKey));

    res.json({
      ...details,
      urn: getObjectUrn(details.objectId),
      sizeFormatted: formatBytes(details.size),
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/manifest/:urn', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { urn } = req.params;
    const manifest = await fetchManifest(urn);
    const analysis = analyzeManifest(manifest);

    res.json({
      ...manifest,
      _analysis: {
        hasSvf: analysis.hasSvf,
        hasSvf2: analysis.hasSvf2,
        svfHasUrns: analysis.svfHasUrns,
        svf2HasUrns: analysis.svf2HasUrns,
        available: analysis.available,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/translate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validation = TranslateRequestSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: validation.error.errors,
      });
      return;
    }

    const { urn, outputFormat, outputFormats, views, rootFilename, compressedUrn } = validation.data;

    console.log(`[API] Starting translation for URN: ${urn.substring(0, 40)}...`);

    const result = await startTranslation({
      urn,
      outputFormat: outputFormat as OutputFormat,
      outputFormats: outputFormats as OutputFormat[] | undefined,
      views: views as ('2d' | '3d')[],
      rootFilename,
      compressedUrn,
    });

    res.status(202).json({
      message: 'Translation job started',
      urn,
      result: result.result,
      acceptedJobs: result.acceptedJobs,
      statusUrl: `/api/translate/${encodeURIComponent(urn)}/status`,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/translate/:urn/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { urn } = req.params;

    const status = await getTranslationStatus(urn);

    res.json(status);
  } catch (error) {
    next(error);
  }
});

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

app.post('/api/download-derivative', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validation = DownloadRequestSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: validation.error.errors,
      });
      return;
    }

    const { urn, prefer, autoGenerateSvf } = validation.data;
    const jobId = uuidv4();

    createJob(jobId, urn);
    updateJob(jobId, { status: 'running' });

    res.status(202).json({
      message: 'Download started',
      jobId,
      downloadRunId: jobId,
      urn,
      preference: prefer,
      autoGenerateSvf,
      statusUrl: `/api/download-derivative/${jobId}/status`,
    });

    const startTime = Date.now();

    try {
      console.log(`[Job ${jobId}] Starting download for URN: ${urn.substring(0, 40)}...`);
      console.log(`[Job ${jobId}] Preference: ${prefer}, autoGenerateSvf: ${autoGenerateSvf}`);

      let result = await downloadDerivatives({
        urn,
        preference: prefer,
        outputBaseDir: DOWNLOAD_DIR,
        downloadRunId: jobId,
        autoGenerateSvf,
        onProgress: (downloaded) => {
          updateJob(jobId, {
            filesDownloaded: downloaded,
            durationMs: Date.now() - startTime,
          });
        },
      });

      if (result.needsSvfGeneration) {
        console.log(`[Job ${jobId}] SVF generation needed, starting translation job...`);

        updateJob(jobId, {
          warnings: [...(result.warnings || []), 'Generating SVF derivative...'],
        });

        const ensureResult = await ensureSvf1Derivative(urn);
        console.log(
          `[Job ${jobId}] SVF ${ensureResult.alreadyExists ? 'already existed' : 'was generated'} ` +
            `(${ensureResult.durationMs}ms)`
        );

        result = await downloadDerivatives({
          urn,
          preference: 'svf',
          outputBaseDir: DOWNLOAD_DIR,
          downloadRunId: jobId,
          autoGenerateSvf: true,
          svfGenerated: ensureResult.jobStarted,
          manifest: ensureResult.manifest,
          onProgress: (downloaded) => {
            updateJob(jobId, {
              filesDownloaded: downloaded,
              durationMs: Date.now() - startTime,
            });
          },
        });

        result.warnings.push(
          ensureResult.jobStarted
            ? 'SVF derivative was generated (translation job executed)'
            : 'SVF derivative was already available'
        );
      }

      updateJob(jobId, {
        status: result.failedCount > 0 ? 'failed' : 'completed',
        derivativeType: result.derivativeType,
        outputDir: result.outputDir,
        filesDownloaded: result.successCount,
        filesFailed: result.failedCount,
        bytesDownloaded: result.totalBytes,
        durationMs: Date.now() - startTime,
        failedFiles: result.failedFiles.length > 0 ? result.failedFiles : undefined,
        error: result.failedCount > 0 ? `${result.failedCount} files failed to download` : undefined,
        warnings: result.warnings.length > 0 ? result.warnings : undefined,
      });

      console.log(
        `[Job ${jobId}] Completed: ${result.successCount} files, ` +
          `${(result.totalBytes / 1024 / 1024).toFixed(2)} MB, type: ${result.derivativeType}`
      );

      if (result.warnings.length > 0) {
        console.log(`[Job ${jobId}] Warnings: ${result.warnings.join('; ')}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';

      if (message.includes('set autoGenerateSvf=true')) {
        updateJob(jobId, {
          status: 'failed',
          error: message,
          durationMs: Date.now() - startTime,
          warnings: ['SVF not available. Retry with autoGenerateSvf=true to generate it.'],
        });
      } else {
        updateJob(jobId, {
          status: 'failed',
          error: message,
          durationMs: Date.now() - startTime,
        });
      }

      console.error(`[Job ${jobId}] Failed:`, message);
    }
  } catch (error) {
    next(error);
  }
});

app.get('/api/download-derivative/:jobId/status', (req: Request, res: Response) => {
  const { jobId } = req.params;
  const job = getJob(jobId);

  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  res.json(job);
});

app.get('/api/jobs', (_req: Request, res: Response) => {
  const jobs = getAllJobs();
  res.json({ jobs });
});

app.post('/api/convert-to-glb', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validation = ConvertRequestSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: validation.error.errors,
      });
      return;
    }

    const { urn, viewName, outputName, quality } = validation.data;
    const runId = uuidv4();
    const safeUrn = sanitizeUrn(urn);

    if (isLocked(urn, runId)) {
      res.status(409).json({
        error: 'Conversion in progress',
        message: 'A conversion for this URN is already in progress.',
        urn,
      });
      return;
    }

    console.log(`[Convert] Starting direct conversion for URN: ${urn.substring(0, 50)}...`);
    console.log(`[Convert] Run ID: ${runId}`);

    console.log(`[Convert] Phase 1: Checking SVF availability...`);
    const svfCheck = await checkSvfAvailable(urn);
    console.log(`[Convert] SVF available: ${svfCheck.hasSvf}, SVF2 available: ${svfCheck.hasSvf2}`);

    if (!svfCheck.hasSvf && svfCheck.hasSvf2) {
      console.log(`[Convert] Only SVF2 found, triggering SVF1 generation...`);
      const ensureResult = await ensureSvf1Derivative(urn);
      console.log(
        `[Convert] SVF1 ${ensureResult.alreadyExists ? 'already existed' : 'was generated'} ` +
          `(${ensureResult.durationMs}ms)`
      );
    } else if (!svfCheck.hasSvf && !svfCheck.hasSvf2) {
      res.status(422).json({
        error: 'No viewable derivatives',
        message: 'Model has no SVF or SVF2 derivatives. Ensure it has been translated.',
        urn,
      });
      return;
    }

    console.log(`[Convert] Phase 2: Converting SVF to GLB using forge-convert-utils...`);
    console.log(`[Convert] This downloads all required assets directly from APS (FragmentList.pack, etc.)...`);

    const outputDir = path.join(CONVERTED_DIR, safeUrn, runId);

    const result = await convertFromDerivativeService(urn, outputDir, runId, {
      quality,
      viewName,
      outputName,
    });

    if (!result.success) {
      res.status(500).json({
        error: 'Conversion failed',
        message: result.error,
        urn,
        runId,
        durationMs: result.durationMs,
      });
      return;
    }

    console.log(`[Convert] Phase 3: GLB saved successfully`);
    console.log(`[Convert] Output: ${result.outputFile}`);
    console.log(`[Convert] Size: ${(result.outputBytes / 1024 / 1024).toFixed(2)} MB`);

    res.json({
      success: true,
      urn,
      runId,
      viewableGuid: result.viewableGuid,
      viewableName: result.viewableName,
      glbPath: result.outputFile,
      glbUrl: result.glbUrl,
      bytes: result.outputBytes,
      meshCount: result.meshCount,
      materialCount: result.materialCount,
      optimizations: result.optimizations,
      durationMs: result.durationMs,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/convert-status/:urn/:runId', async (req: Request, res: Response) => {
  const { urn, runId } = req.params;
  const safeUrn = sanitizeUrn(urn);

  const convertJsonPath = path.join(CONVERTED_DIR, safeUrn, runId, 'convert.json');

  const converting = isLocked(urn, runId);

  try {
    await fs.promises.access(convertJsonPath);
    const metadata = JSON.parse(await fs.promises.readFile(convertJsonPath, 'utf-8'));

    res.json({
      status: metadata.success ? 'completed' : 'failed',
      converting,
      metadata,
    });
  } catch {
    res.json({
      status: converting ? 'converting' : 'not_found',
      converting,
    });
  }
});

function sanitizeModelId(modelId: string): string {
  return modelId.replace(/[^a-zA-Z0-9_:-]/g, '_');
}

app.get('/api/alignment', async (req: Request, res: Response) => {
  const urn = req.query.urn as string;
  const modelId = req.query.modelId as string;

  const effectiveId = modelId || (urn ? `aps:${urn}` : null);

  if (!effectiveId) {
    res.status(400).json({ error: 'Either modelId or urn query parameter is required' });
    return;
  }

  const safeId = modelId ? sanitizeModelId(modelId) : sanitizeUrn(urn);
  const alignmentPath = path.join(ALIGNMENT_DIR, `${safeId}.json`);

  try {
    const content = await fs.promises.readFile(alignmentPath, 'utf-8');
    const alignment = JSON.parse(content);
    res.json(alignment);
  } catch {
    res.json({
      modelId: effectiveId,
      urn: urn || null,
      matrix: getIdentityMatrix(),
      units: 'm',
      updatedAt: null,
      isDefault: true,
    });
  }
});

app.post('/api/alignment', async (req: Request, res: Response) => {
  console.log('[Alignment] POST /api/alignment received');
  console.log('[Alignment] Body keys:', Object.keys(req.body));
  
  const hasModelId = 'modelId' in req.body;

  if (hasModelId) {
    console.log('[Alignment] Using modelId-based alignment');
    const validation = AlignmentByModelIdSchema.safeParse(req.body);

    if (!validation.success) {
      console.log('[Alignment] Validation failed:', validation.error.errors);
      res.status(400).json({
        error: 'Validation failed',
        details: validation.error.errors,
      });
      return;
    }

    const { modelId, matrix, units } = validation.data;
    const safeId = sanitizeModelId(modelId);
    console.log(`[Alignment] modelId: ${modelId.substring(0, 50)}...`);
    console.log(`[Alignment] safeId: ${safeId}`);

    try {
      await ensureDir(ALIGNMENT_DIR);

      const alignment = {
        modelId,
        matrix,
        units,
        updatedAt: new Date().toISOString(),
      };

      const alignmentPath = path.join(ALIGNMENT_DIR, `${safeId}.json`);
      console.log(`[Alignment] Writing to: ${alignmentPath}`);
      
      await fs.promises.writeFile(alignmentPath, JSON.stringify(alignment, null, 2));

      console.log(`[Alignment] Saved alignment for modelId: ${modelId.substring(0, 30)}...`);
      res.json({ success: true, ...alignment });
    } catch (err: any) {
      console.error('[Alignment] Error saving alignment:', err);
      res.status(500).json({
        error: 'Failed to save alignment',
        message: err.message,
      });
    }
    return;
  }

  const validation = AlignmentSchema.safeParse(req.body);

  if (!validation.success) {
    res.status(400).json({
      error: 'Validation failed',
      details: validation.error.errors,
    });
    return;
  }

  const { urn, matrix, units } = validation.data;
  const safeUrn = sanitizeUrn(urn);

  await ensureDir(ALIGNMENT_DIR);

  const alignment = {
    urn,
    modelId: `aps:${urn}`,
    matrix,
    units,
    updatedAt: new Date().toISOString(),
  };

  const alignmentPath = path.join(ALIGNMENT_DIR, `${safeUrn}.json`);
  await fs.promises.writeFile(alignmentPath, JSON.stringify(alignment, null, 2));

  console.log(`[Alignment] Saved alignment for ${urn.substring(0, 30)}...`);
  res.json({ success: true, ...alignment });
});

app.use('/viewer', express.static(path.join(__dirname, '../public/viewer')));

app.use('/libs', express.static(path.join(__dirname, '../public/libs')));

app.use('/pointclouds', express.static(path.resolve(POINTCLOUD_DIR)));

app.get('/api/pointclouds', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const pointclouds = await listPointClouds(
      path.resolve(POINTCLOUD_DIR),
      path.resolve(POINTCLOUD_RAW_DIR),
      path.resolve(POINTCLOUD_CACHE_DIR)
    );

    res.json({
      count: pointclouds.length,
      pointclouds,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/pointclouds/ensure', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validation = EnsurePointCloudSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: validation.error.errors,
      });
      return;
    }

    const { id, rawFileName } = validation.data;

    let rawFilePath: string | null = null;

    if (id) {
      rawFilePath = await findRawFileById(path.resolve(POINTCLOUD_RAW_DIR), id);
    } else if (rawFileName) {
      rawFilePath = await findRawFileByName(path.resolve(POINTCLOUD_RAW_DIR), rawFileName);
    }

    if (!rawFilePath) {
      res.status(404).json({
        error: 'Raw point cloud not found',
        message: `Could not find raw file for ${id || rawFileName}`,
        hint: 'Place .las/.laz/.e57 files in data/pointclouds_raw/',
      });
      return;
    }

    console.log(`[API] Ensuring Potree point cloud for: ${rawFilePath}`);

    const result = await ensurePotreePointCloud(
      rawFilePath,
      path.resolve(POINTCLOUD_DIR),
      path.resolve(POINTCLOUD_CACHE_DIR)
    );

    if (!result.success) {
      res.status(500).json({
        error: 'Point cloud conversion failed',
        message: result.error,
        stderr: result.stderr?.substring(0, 500),
        durationMs: result.durationMs,
      });
      return;
    }

    const cloudJsUrl = result.cloudJsUrl.replace(/\\/g, '/');
    
    const cloudJsFilePath = path.join(path.resolve(POINTCLOUD_DIR), result.cloudId, 'cloud.js');
    const cloudJsExists = fs.existsSync(cloudJsFilePath);
    
    if (!cloudJsExists) {
      const metadataPath = path.join(path.resolve(POINTCLOUD_DIR), result.cloudId, 'metadata.json');
      const metadataExists = fs.existsSync(metadataPath);
      
      if (!metadataExists) {
        console.error(`[API] Conversion reported success but no output files found for ${result.cloudId}`);
        res.status(500).json({
          error: 'Conversion output missing',
          message: 'Conversion completed but cloud.js/metadata.json not found',
          cloudId: result.cloudId,
          expectedPath: cloudJsFilePath,
          hint: 'Check PotreeConverter logs in data/pointclouds_cache/',
        });
        return;
      }
    }

    console.log(`[API] Point cloud ready: ${cloudJsUrl} (exists: ${cloudJsExists})`);

    res.json({
      success: true,
      id: `pc:potree:${result.cloudId}`,
      cloudId: result.cloudId,
      cloudJsUrl: cloudJsUrl,
      status: 'ready',
      cached: result.cached,
      pointCount: result.pointCount,
      durationMs: result.durationMs,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/pointclouds/debug', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const cloudId = req.query.cloudId as string;
    
    if (!cloudId) {
      res.status(400).json({
        error: 'cloudId query parameter is required',
        example: '/api/pointclouds/debug?cloudId=mycloud_abc123',
      });
      return;
    }

    const cleanCloudId = cloudId.replace(/^pc:potree:/, '');
    const cloudDir = path.join(path.resolve(POINTCLOUD_DIR), cleanCloudId);
    const cacheDir = path.join(path.resolve(POINTCLOUD_CACHE_DIR), cleanCloudId);
    
    const cloudJsPath = path.join(cloudDir, 'cloud.js');
    const metadataPath = path.join(cloudDir, 'metadata.json');
    const convertLogPath = path.join(cacheDir, 'convert.log');
    const convertJsonPath = path.join(cacheDir, 'convert.json');

    const cloudJsExists = fs.existsSync(cloudJsPath);
    const metadataExists = fs.existsSync(metadataPath);
    const dirExists = fs.existsSync(cloudDir);

    let cloudJsSize = 0;
    let metadataSize = 0;
    if (cloudJsExists) {
      cloudJsSize = fs.statSync(cloudJsPath).size;
    }
    if (metadataExists) {
      metadataSize = fs.statSync(metadataPath).size;
    }

    let sampleFiles: string[] = [];
    if (dirExists) {
      try {
        const allFiles = await listFilesRecursive(cloudDir, 10);
        sampleFiles = allFiles.map(f => f.replace(cloudDir, '').replace(/\\/g, '/'));
      } catch {
        sampleFiles = ['(error reading directory)'];
      }
    }

    let convertLog = '';
    let convertMeta: any = null;
    try {
      if (fs.existsSync(convertLogPath)) {
        const log = await fs.promises.readFile(convertLogPath, 'utf-8');
        convertLog = log.substring(log.length - 2000);
      }
    } catch {}
    try {
      if (fs.existsSync(convertJsonPath)) {
        convertMeta = JSON.parse(await fs.promises.readFile(convertJsonPath, 'utf-8'));
      }
    } catch {}

    const cloudJsUrl = `/pointclouds/${encodeURIComponent(cleanCloudId)}/cloud.js`;
    const metadataUrl = `/pointclouds/${encodeURIComponent(cleanCloudId)}/metadata.json`;

    let hints: string[] = [];
    if (!dirExists) {
      hints.push('Output directory does not exist - conversion may not have run');
    } else if (!cloudJsExists && !metadataExists) {
      hints.push('No cloud.js or metadata.json found - conversion may have failed');
      hints.push('Check convert.log for errors');
    } else if (cloudJsExists && cloudJsSize < 100) {
      hints.push('cloud.js file is suspiciously small - may be corrupted');
    }
    if (convertMeta?.error) {
      hints.push(`Conversion error: ${convertMeta.error}`);
    }
    if (hints.length === 0 && (cloudJsExists || metadataExists)) {
      hints.push('Output looks valid - if not loading, check browser console for JS errors');
    }

    res.json({
      cloudId: cleanCloudId,
      cloudJsUrl,
      metadataUrl,
      cloudJsExists,
      metadataExists,
      cloudJsSize,
      metadataSize,
      outputDir: cloudDir.replace(/\\/g, '/'),
      sampleFiles,
      convertMeta: convertMeta ? {
        convertedAt: convertMeta.convertedAt,
        durationMs: convertMeta.durationMs,
        pointCount: convertMeta.pointCount,
        error: convertMeta.error,
      } : null,
      convertLogTail: convertLog || '(no log found)',
      hints,
    });
  } catch (error) {
    next(error);
  }
});

async function listFilesRecursive(dir: string, limit: number): Promise<string[]> {
  const results: string[] = [];
  
  async function walk(currentDir: string) {
    if (results.length >= limit) return;
    
    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= limit) break;
      
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        results.push(fullPath);
      }
    }
  }
  
  await walk(dir);
  return results;
}

interface BimModelItem {
  id: string;
  type: 'glb' | 'ifc';
  source: 'aps' | 'direct';
  name: string;
  urn?: string;
  runId?: string;
  ifcId?: string;
  glbUrl?: string;
  ifcUrl?: string;
  convertedAt?: string | null;
  bytes?: number | null;
}

app.get('/api/bim-models', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const models: BimModelItem[] = [];

    try {
      const urnDirs = await fs.promises.readdir(CONVERTED_DIR, { withFileTypes: true });

      for (const urnDir of urnDirs) {
        if (!urnDir.isDirectory()) continue;

        const urnPath = path.join(CONVERTED_DIR, urnDir.name);
        const runDirs = await fs.promises.readdir(urnPath, { withFileTypes: true });

        for (const runDir of runDirs) {
          if (!runDir.isDirectory()) continue;

          const glbPath = path.join(urnPath, runDir.name, 'model.glb');
          const convertJsonPath = path.join(urnPath, runDir.name, 'convert.json');

          try {
            await fs.promises.access(glbPath);

            let convertedAt: string | null = null;
            let bytes: number | null = null;
            let viewableName: string | null = null;

            try {
              const convertJson = JSON.parse(
                await fs.promises.readFile(convertJsonPath, 'utf-8')
              );
              convertedAt = convertJson.completedAt || convertJson.convertedAt || null;
              bytes = convertJson.outputBytes || null;
              viewableName = convertJson.viewableName || null;
            } catch {
              const stat = await fs.promises.stat(glbPath);
              convertedAt = stat.mtime.toISOString();
              bytes = stat.size;
            }

            models.push({
              id: `aps:${urnDir.name}:${runDir.name}`,
              type: 'glb',
              source: 'aps',
              urn: urnDir.name,
              runId: runDir.name,
              name: viewableName || `[APS] ${urnDir.name.substring(0, 15)}...`,
              glbUrl: `/assets/models/${encodeURIComponent(urnDir.name)}/${encodeURIComponent(runDir.name)}/model.glb`,
              convertedAt,
              bytes,
            });
          } catch {
            // model.glb doesn't exist, skip
          }
        }
      }
    } catch (err) {
      console.warn('[API] Could not read converted directory:', err);
    }

    try {
      const ifcModels = await listIfcModels(IFC_DIR);

      for (const ifc of ifcModels) {
        models.push({
          id: `ifc:${ifc.ifcId}`,
          type: 'ifc',
          source: 'direct',
          ifcId: ifc.ifcId,
          name: `[IFC] ${ifc.name}`,
          ifcUrl: `/ifc/${encodeURIComponent(ifc.ifcId)}/model.ifc`,
          bytes: ifc.bytes,
          convertedAt: ifc.modifiedAt,
        });
      }
    } catch (err) {
      console.warn('[API] Could not list IFC models:', err);
    }

    models.sort((a, b) => {
      if (!a.convertedAt && !b.convertedAt) return 0;
      if (!a.convertedAt) return 1;
      if (!b.convertedAt) return -1;
      return new Date(b.convertedAt).getTime() - new Date(a.convertedAt).getTime();
    });

    res.json({
      count: models.length,
      models,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/ifc/upload', uploadIfc.single('file'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No IFC file uploaded' });
      return;
    }

    const ifcId = req.body.ifcId;
    const ifcPath = req.file.path;
    const stat = await fs.promises.stat(ifcPath);

    console.log(`[IFC] Uploaded IFC: ${ifcId} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);

    res.json({
      success: true,
      ifcId,
      name: req.file.originalname,
      ifcPath,
      ifcUrl: `/ifc/${encodeURIComponent(ifcId)}/model.ifc`,
      bytes: stat.size,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/ifc/ensure-glb', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validation = IfcEnsureGlbSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: validation.error.errors,
      });
      return;
    }

    const { ifcId, quality, skipOptimization } = validation.data;
    const ifcPath = path.join(IFC_DIR, ifcId, 'model.ifc');

    try {
      await fs.promises.access(ifcPath);
    } catch {
      res.status(404).json({
        error: 'IFC not found',
        message: `IFC file not found at ${ifcPath}`,
        ifcId,
      });
      return;
    }

    console.log(`[IFC] Ensuring GLB for IFC: ${ifcId}`);
    console.log(`[IFC] Quality: ${quality}, Skip optimization: ${skipOptimization}`);

    const result = await convertIfcToGlb(ifcId, ifcPath, CONVERTED_IFC_DIR, {
      quality,
      skipOptimization,
    });

    if (!result.success) {
      res.status(500).json({
        error: 'IFC conversion failed',
        message: result.error,
        stderr: result.stderr?.substring(0, 1000),
        ifcId,
        durationMs: result.durationMs,
      });
      return;
    }

    res.json({
      success: true,
      ifcId,
      hash: result.hash,
      glbUrl: result.glbUrl,
      bytes: result.outputBytes,
      cached: result.cached,
      optimizations: result.optimizations,
      durationMs: result.durationMs,
    });
  } catch (error) {
    next(error);
  }
});

app.use('/ifc', express.static(path.resolve(IFC_DIR)));

app.get('/assets/ifc-models/:ifcId/:hash/model.glb', async (req: Request, res: Response) => {
  const { ifcId, hash } = req.params;
  const glbPath = path.join(CONVERTED_IFC_DIR, ifcId, hash, 'model.glb');

  try {
    await fs.promises.access(glbPath);

    res.setHeader('Content-Type', 'model/gltf-binary');
    res.setHeader('Cache-Control', 'public, max-age=31536000');

    const stream = fs.createReadStream(glbPath);
    stream.pipe(res);
  } catch {
    res.status(404).json({
      error: 'IFC GLB not found',
      message: 'GLB file does not exist. Call /api/ifc/ensure-glb first.',
      ifcId,
      hash,
    });
  }
});

app.get('/assets/models/:urn/:downloadRunId/model.glb', async (req: Request, res: Response) => {
  const { urn, downloadRunId } = req.params;
  const safeUrn = sanitizeUrn(decodeURIComponent(urn));
  const glbPath = path.join(CONVERTED_DIR, safeUrn, downloadRunId, 'model.glb');

  try {
    await fs.promises.access(glbPath);

    res.setHeader('Content-Type', 'model/gltf-binary');
    res.setHeader('Cache-Control', 'public, max-age=31536000');

    const stream = fs.createReadStream(glbPath);
    stream.pipe(res);
  } catch {
    res.status(404).json({
      error: 'Model not found',
      message: 'GLB file does not exist. Run conversion first.',
      path: glbPath,
      urn,
      downloadRunId,
    });
  }
});

app.get('/assets/models/:urn.glb', async (_req: Request, res: Response) => {
  res.status(400).json({
    error: 'Invalid URL format',
    message: 'Use /assets/models/:urn/:downloadRunId/model.glb instead',
    example: '/assets/models/dXJu.../abc123/model.glb',
  });
});

// ============================================================================
// Mock Properties Endpoint (ENTREGA 2 - Enhanced with cache and richer data)
// Provides deterministic fake properties based on selection key hash
// This will be replaced by real APS properties.db later
// ============================================================================

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

function seededRandom(seed: number): () => number {
  return function() {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

interface MockPropertiesResponse {
  element: {
    key: string;
    name: string;
    pseudoDbId: number;
    externalId: string;
  };
  source: 'mock';
  units: 'm';
  cachedAt: string;
  groups: Array<{
    group: string;
    expanded: boolean;
    props: Array<{ name: string; value: string; type?: string }>;
  }>;
}

const mockPropertiesCache = new Map<string, MockPropertiesResponse>();

function generateMockProperties(key: string, name: string): MockPropertiesResponse {
  const seed = simpleHash(key);
  const random = seededRandom(seed);
  const pseudoDbId = seed % 1000000;
  const externalId = `ext-${seed.toString(16).padStart(8, '0')}`;

  const categories = ['Walls', 'Doors', 'Windows', 'Floors', 'Structural Columns', 'Structural Framing', 'Ceilings', 'Roofs', 'Stairs', 'Railings', 'Casework', 'Generic Models'];
  const category = categories[Math.floor(random() * categories.length)];

  const familiesByCategory: Record<string, string[]> = {
    'Walls': ['Basic Wall', 'Curtain Wall', 'Stacked Wall'],
    'Doors': ['Single-Flush', 'Double-Flush', 'Sliding', 'Bi-Fold', 'Revolving'],
    'Windows': ['Fixed', 'Casement', 'Awning', 'Double Hung', 'Sliding'],
    'Floors': ['Floor', 'Floor: Structural'],
    'Structural Columns': ['Concrete-Rectangular-Column', 'Concrete-Round-Column', 'Steel-Wide Flange-Column'],
    'Structural Framing': ['Concrete-Rectangular Beam', 'Steel-Wide Flange', 'Wood-Timber'],
    'Ceilings': ['Compound Ceiling', 'Basic Ceiling'],
    'Roofs': ['Basic Roof', 'Sloped Glazing'],
    'Stairs': ['Assembled Stair', 'Cast-In-Place Stair', 'Precast Stair'],
    'Railings': ['Handrail - Pipe', 'Handrail - Rectangular', 'Guardrail - Pipe'],
    'Casework': ['Base Cabinet', 'Upper Cabinet', 'Tall Cabinet'],
    'Generic Models': ['Generic Model'],
  };
  const families = familiesByCategory[category] || ['Standard'];
  const family = families[Math.floor(random() * families.length)];

  const typesByCategory: Record<string, string[]> = {
    'Walls': ['Generic - 200mm', 'Exterior - Brick on CMU', 'Interior - 135mm Partition', 'Concrete 250mm', 'CW 102-50-100p'],
    'Doors': ['0915 x 2134mm', '0864 x 2032mm', '1830 x 2134mm', 'Fire Rated 90min'],
    'Windows': ['0610 x 1220mm', '0915 x 1525mm', '1220 x 1830mm', 'Storefront'],
    'Floors': ['Generic 300mm', 'Concrete with Tile', 'Wood Joist 250mm'],
    'Structural Columns': ['450 x 450mm', '600 x 600mm', 'W12x26', 'W14x48'],
    'Structural Framing': ['300 x 600mm', 'W10x22', 'W12x26', '200 x 400mm'],
    'Ceilings': ['600 x 600mm Grid', '2x2 ACT System', 'GWB on Mtl. Stud'],
    'Roofs': ['Generic - 400mm', 'Steel Truss - Insulated', 'Concrete - Membrane'],
    'Stairs': ['Residential - 900mm', 'Commercial - 1200mm', 'Monumental - 1800mm'],
    'Railings': ['900mm', '1050mm', '1100mm'],
    'Casework': ['Base - 600mm', 'Base - 900mm', 'Upper - 300mm'],
    'Generic Models': ['Default'],
  };
  const types = typesByCategory[category] || ['Standard'];
  const type = types[Math.floor(random() * types.length)];

  const markPrefix = category.charAt(0).toUpperCase();
  const markNumber = Math.floor(random() * 900) + 100;
  const mark = `${markPrefix}-${markNumber}`;

  const levelNames = ['Level 00', 'Level 01', 'Level 02', 'Level 03', 'Level 04', 'B1 - Basement', 'Ground Floor', 'Roof'];
  const baseLevel = levelNames[Math.floor(random() * levelNames.length)];
  const topLevel = levelNames[Math.min(levelNames.indexOf(baseLevel) + 1 + Math.floor(random() * 2), levelNames.length - 1)];

  const baseOffset = (random() * 0.5 - 0.1).toFixed(3);
  const topOffset = (random() * 0.3 - 0.1).toFixed(3);

  const length = (random() * 5.5 + 0.5).toFixed(3);
  const width = (random() * 3.0 + 0.2).toFixed(3);
  const height = (random() * 3.5 + 2.4).toFixed(3);
  const thickness = (random() * 0.35 + 0.1).toFixed(3);
  const area = (parseFloat(length) * parseFloat(height)).toFixed(2);
  const volume = (parseFloat(length) * parseFloat(width) * parseFloat(height)).toFixed(3);
  const perimeter = ((parseFloat(length) + parseFloat(width)) * 2).toFixed(2);

  const structuralMaterials = ['Concrete, Cast-in-Place gray', 'Steel, ASTM A992', 'Concrete, Precast', 'Wood - Lumber', 'Aluminum'];
  const structuralMaterial = structuralMaterials[Math.floor(random() * structuralMaterials.length)];
  
  const finishMaterials = ['Paint', 'Ceramic Tile', 'Gypsum Wall Board', 'Wood - Cherry', 'Glass', 'Brick, Common'];
  const finishMaterial = finishMaterials[Math.floor(random() * finishMaterials.length)];

  const fireRatings = ['', '30 min', '60 min', '90 min', '120 min', '180 min'];
  const fireRating = fireRatings[Math.floor(random() * fireRatings.length)];

  const thermalValues = ['', 'R-13', 'R-19', 'R-21', 'R-30', 'R-38'];
  const thermalResistance = thermalValues[Math.floor(random() * thermalValues.length)];

  const phases = ['Existing', 'New Construction', 'Demolition', 'Temporary'];
  const phaseCreated = phases[Math.floor(random() * 3)];
  const phaseDemolished = random() > 0.8 ? phases[3] : '';

  const designOptions = ['Main Model', 'Option A', 'Option B'];
  const designOption = designOptions[Math.floor(random() * designOptions.length)];

  const worksets = ['Shared Levels and Grids', 'Architecture', 'Structure', 'MEP', 'Interiors'];
  const workset = worksets[Math.floor(random() * worksets.length)];

  const ifcGuid = `${seed.toString(16).padStart(8, '0').toUpperCase()}-${(seed * 2).toString(16).padStart(4, '0').toUpperCase()}-${(seed * 3).toString(16).padStart(4, '0').toUpperCase()}-${(seed * 4).toString(16).padStart(4, '0').toUpperCase()}-${(seed * 5).toString(16).padStart(12, '0').toUpperCase()}`;

  const createdYear = 2020 + Math.floor(random() * 6);
  const createdMonth = Math.floor(random() * 12) + 1;
  const createdDay = Math.floor(random() * 28) + 1;
  const createdDate = `${createdYear}-${createdMonth.toString().padStart(2, '0')}-${createdDay.toString().padStart(2, '0')}`;

  const displayName = name || key;

  return {
    element: {
      key,
      name: displayName,
      pseudoDbId,
      externalId,
    },
    source: 'mock',
    units: 'm',
    cachedAt: new Date().toISOString(),
    groups: [
      {
        group: 'Identity Data',
        expanded: true,
        props: [
          { name: 'Category', value: category },
          { name: 'Family', value: family },
          { name: 'Type', value: type },
          { name: 'Type Name', value: `${family}: ${type}` },
          { name: 'Mark', value: mark },
          { name: 'Comments', value: '' },
        ],
      },
      {
        group: 'Constraints',
        expanded: true,
        props: [
          { name: 'Base Constraint', value: baseLevel },
          { name: 'Base Offset', value: `${baseOffset} m`, type: 'length' },
          { name: 'Top Constraint', value: topLevel },
          { name: 'Top Offset', value: `${topOffset} m`, type: 'length' },
          { name: 'Room Bounding', value: random() > 0.3 ? 'Yes' : 'No' },
          { name: 'Related to Mass', value: 'No' },
        ],
      },
      {
        group: 'Dimensions',
        expanded: true,
        props: [
          { name: 'Length', value: `${length} m`, type: 'length' },
          { name: 'Width', value: `${width} m`, type: 'length' },
          { name: 'Height', value: `${height} m`, type: 'length' },
          { name: 'Thickness', value: `${thickness} m`, type: 'length' },
          { name: 'Area', value: `${area} m²`, type: 'area' },
          { name: 'Volume', value: `${volume} m³`, type: 'volume' },
          { name: 'Perimeter', value: `${perimeter} m`, type: 'length' },
        ],
      },
      {
        group: 'Materials and Finishes',
        expanded: false,
        props: [
          { name: 'Structural Material', value: structuralMaterial },
          { name: 'Finish Material', value: finishMaterial },
          { name: 'Color', value: ['White', 'Gray', 'Beige', 'Brown', 'Black'][Math.floor(random() * 5)] },
        ],
      },
      {
        group: 'Analytical Properties',
        expanded: false,
        props: [
          { name: 'Fire Rating', value: fireRating || 'Not Rated' },
          { name: 'Thermal Resistance (R)', value: thermalResistance || 'Not Defined' },
          { name: 'Acoustic Rating', value: random() > 0.5 ? `STC ${Math.floor(random() * 30 + 35)}` : 'Not Defined' },
        ],
      },
      {
        group: 'Phasing',
        expanded: false,
        props: [
          { name: 'Phase Created', value: phaseCreated },
          { name: 'Phase Demolished', value: phaseDemolished || 'None' },
        ],
      },
      {
        group: 'IFC Parameters',
        expanded: false,
        props: [
          { name: 'IFC GUID', value: ifcGuid },
          { name: 'Export to IFC', value: 'By Type' },
          { name: 'IFC Type', value: `Ifc${category.replace(/s$/, '').replace(/ /g, '')}` },
        ],
      },
      {
        group: 'Other',
        expanded: false,
        props: [
          { name: 'Design Option', value: designOption },
          { name: 'Workset', value: workset },
          { name: 'Element ID', value: `#${pseudoDbId}` },
          { name: 'Created', value: createdDate },
          { name: 'Last Modified', value: new Date().toISOString().split('T')[0] },
        ],
      },
    ],
  };
}

app.get('/api/mock-properties', (req: Request, res: Response) => {
  const key = req.query.key as string;
  const name = req.query.name as string || '';

  if (!key) {
    res.status(400).json({
      error: 'Missing required parameter: key',
      message: 'Provide a selection key via ?key=<value>',
    });
    return;
  }

  let data = mockPropertiesCache.get(key);
  
  if (!data) {
    data = generateMockProperties(key, name);
    mockPropertiesCache.set(key, data);
    console.log(`[MockProps] Generated and cached properties for key: ${key.substring(0, 30)}...`);
  } else {
    console.log(`[MockProps] Returning cached properties for key: ${key.substring(0, 30)}...`);
  }

  res.json(data);
});

app.delete('/api/mock-properties/cache', (_req: Request, res: Response) => {
  const count = mockPropertiesCache.size;
  mockPropertiesCache.clear();
  console.log(`[MockProps] Cache cleared (${count} entries)`);
  res.json({ success: true, clearedEntries: count });
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[Server] Error:', err.message);
  console.error(err.stack);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
  });
});

async function startServer() {
  await ensureDir(POINTCLOUD_DIR);
  await ensureDir(POINTCLOUD_RAW_DIR);
  await ensureDir(POINTCLOUD_CACHE_DIR);
  await ensureDir(ALIGNMENT_DIR);
  await ensureDir(DOWNLOAD_DIR);
  await ensureDir(IFC_DIR);
  await ensureDir(CONVERTED_IFC_DIR);

  app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════════════════╗
║         Potree BIM Demo - APS Derivative & Potree Viewer               ║
╠════════════════════════════════════════════════════════════════════════╣
║  Server running at: http://localhost:${PORT}                              ║
║                                                                        ║
║  APS / Forge Endpoints:                                                ║
║    GET  /api/buckets                       - List buckets              ║
║    GET  /api/buckets/:key/objects          - List bucket objects       ║
║    GET  /api/manifest/:urn                 - Get manifest + analysis   ║
║    POST /api/translate                     - Start translation job     ║
║    POST /api/download-derivative           - Download derivatives      ║
║    POST /api/convert-to-glb                - Convert SVF to GLB        ║
║                                                                        ║
║  IFC Direct Endpoints:                                                 ║
║    POST /api/ifc/upload                    - Upload IFC file           ║
║    POST /api/ifc/ensure-glb                - Convert IFC to GLB        ║
║                                                                        ║
║  Point Cloud Endpoints:                                                ║
  ║    GET  /api/pointclouds                   - List clouds (raw+potree)  ║
  ║    POST /api/pointclouds/ensure            - Convert RAW to Potree     ║
  ║    GET  /api/pointclouds/debug?cloudId=    - Debug point cloud status  ║
║                                                                        ║
║  Viewer Endpoints:                                                     ║
  ║    GET  /api/bim-models                    - List BIM models (APS+IFC) ║
  ║    GET  /api/alignment?modelId=            - Get alignment matrix      ║
  ║    POST /api/alignment                     - Save alignment matrix     ║
  ║    GET  /api/mock-properties?key=          - Mock properties (ENTREGA1)║
  ║    GET  /viewer                            - Potree + BIM viewer       ║
╚════════════════════════════════════════════════════════════════════════╝
    `);
  });
}

startServer();

export default app;
