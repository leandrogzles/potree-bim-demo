import fs from 'fs';
import path from 'path';
import { SvfReader, GltfWriter } from 'forge-convert-utils';
import { optimizeGlb, getGlbStats } from './optimize';
import { withConversionLock } from './lock';
import type {
  ConversionQuality,
  ConvertMetadata,
  ConvertLogEntry,
} from '../aps/types';

export interface ConvertOptions {
  quality: ConversionQuality;
  skipOptimization?: boolean;
  log?: boolean;
}

export interface ConvertResult {
  success: boolean;
  outputFile: string;
  glbUrl: string;
  inputDir: string;
  inputBytes: number;
  outputBytes: number;
  meshCount: number;
  materialCount: number;
  durationMs: number;
  optimizations: string[];
  error?: string;
}

function createLogger(logs: ConvertLogEntry[]) {
  return (phase: string, message: string, durationMs?: number) => {
    const entry: ConvertLogEntry = {
      phase,
      timestamp: new Date().toISOString(),
      message,
      durationMs,
    };
    logs.push(entry);
    console.log(`[Convert:${phase}] ${message}${durationMs ? ` (${durationMs}ms)` : ''}`);
  };
}

async function findSvfFile(inputDir: string): Promise<string | null> {
  async function searchDir(dir: string): Promise<string | null> {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isFile() && entry.name.endsWith('.svf')) {
        return fullPath;
      }

      if (entry.isDirectory()) {
        const found = await searchDir(fullPath);
        if (found) return found;
      }
    }

    return null;
  }

  return searchDir(inputDir);
}

async function calculateDirSize(dir: string): Promise<number> {
  let totalSize = 0;

  async function walkDir(currentDir: string): Promise<void> {
    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isFile()) {
        const stat = await fs.promises.stat(fullPath);
        totalSize += stat.size;
      } else if (entry.isDirectory()) {
        await walkDir(fullPath);
      }
    }
  }

  await walkDir(dir);
  return totalSize;
}

export async function convertSvfToGlb(
  inputDir: string,
  outputFile: string,
  urn: string,
  downloadRunId: string,
  options: ConvertOptions = { quality: 'balanced' }
): Promise<ConvertResult> {
  return withConversionLock(urn, downloadRunId, async () => {
    const startTime = Date.now();
    const logs: ConvertLogEntry[] = [];
    const log = createLogger(logs);

    log('init', `Starting conversion for run: ${downloadRunId}`);
    log('init', `Input directory: ${inputDir}`);
    log('init', `Output file: ${outputFile}`);
    log('init', `Quality: ${options.quality}`);

    try {
      const svfPath = await findSvfFile(inputDir);
      if (!svfPath) {
        throw new Error(
          `No .svf file found in ${inputDir}. ` +
            `Ensure you have downloaded an SVF (not SVF2) derivative.`
        );
      }

      log('detect', `Found SVF file: ${svfPath}`);

      const inputBytes = await calculateDirSize(inputDir);
      log('detect', `Input size: ${(inputBytes / 1024 / 1024).toFixed(2)} MB`);

      await fs.promises.mkdir(path.dirname(outputFile), { recursive: true });

      log('convert', 'Reading SVF with forge-convert-utils...');
      const readStart = Date.now();
      const reader = await SvfReader.FromFileSystem(svfPath);
      const svf = await reader.read();
      log('convert', 'SVF read complete', Date.now() - readStart);

      const rawGlbPath = outputFile.replace('.glb', '.raw.glb');

      log('convert', 'Writing to glTF/GLB...');
      const writeStart = Date.now();
      const writerOptions: Record<string, unknown> = {
        deduplicate: false,
        skipUnusedUvs: true,
        center: false,
      };
      if (options.log) {
        writerOptions.log = console.log;
      }
      const writer = new GltfWriter(writerOptions as ConstructorParameters<typeof GltfWriter>[0]);

      await writer.write(svf, rawGlbPath);
      log('convert', 'GLB write complete', Date.now() - writeStart);

      let finalGlbPath = rawGlbPath;
      let optimizations: string[] = [];
      let outputBytes: number;

      if (!options.skipOptimization) {
        log('optimize', `Optimizing GLB with quality: ${options.quality}`);
        const optimizeStart = Date.now();

        const optimizeResult = await optimizeGlb(rawGlbPath, outputFile, options.quality);

        optimizations = optimizeResult.optimizationsApplied;
        outputBytes = optimizeResult.outputBytes;
        finalGlbPath = outputFile;

        log('optimize', 'Optimization complete', Date.now() - optimizeStart);

        await fs.promises.unlink(rawGlbPath).catch(() => {});
      } else {
        await fs.promises.rename(rawGlbPath, outputFile);
        finalGlbPath = outputFile;
        const stat = await fs.promises.stat(outputFile);
        outputBytes = stat.size;
        log('optimize', 'Optimization skipped');
      }

      log('stats', 'Collecting GLB statistics...');
      const stats = await getGlbStats(finalGlbPath);

      const durationMs = Date.now() - startTime;
      log('complete', `Conversion successful in ${durationMs}ms`);

      const glbUrl = `/assets/models/${encodeURIComponent(urn)}/${encodeURIComponent(downloadRunId)}/model.glb`;

      const metadata: ConvertMetadata = {
        urn,
        downloadRunId,
        inputDir,
        outputFile: finalGlbPath,
        startedAt: new Date(startTime).toISOString(),
        completedAt: new Date().toISOString(),
        quality: options.quality,
        success: true,
        meshCount: stats.meshCount,
        materialCount: stats.materialCount,
        inputBytes,
        outputBytes,
        durationMs,
        optimizations,
        logs,
      };

      const convertJsonPath = path.join(path.dirname(outputFile), 'convert.json');
      await fs.promises.writeFile(convertJsonPath, JSON.stringify(metadata, null, 2));

      return {
        success: true,
        outputFile: finalGlbPath,
        glbUrl,
        inputDir,
        inputBytes,
        outputBytes,
        meshCount: stats.meshCount,
        materialCount: stats.materialCount,
        durationMs,
        optimizations,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      log('error', `Conversion failed: ${message}`);

      const metadata: ConvertMetadata = {
        urn,
        downloadRunId,
        inputDir,
        outputFile,
        startedAt: new Date(startTime).toISOString(),
        completedAt: new Date().toISOString(),
        quality: options.quality,
        success: false,
        error: message,
        inputBytes: 0,
        outputBytes: 0,
        durationMs: Date.now() - startTime,
        optimizations: [],
        logs,
      };

      const convertJsonPath = path.join(path.dirname(outputFile), 'convert.json');
      await fs.promises.mkdir(path.dirname(convertJsonPath), { recursive: true });
      await fs.promises.writeFile(convertJsonPath, JSON.stringify(metadata, null, 2));

      return {
        success: false,
        outputFile,
        glbUrl: '',
        inputDir,
        inputBytes: 0,
        outputBytes: 0,
        meshCount: 0,
        materialCount: 0,
        durationMs: Date.now() - startTime,
        optimizations: [],
        error: message,
      };
    }
  });
}

export async function loadConvertMetadata(convertDir: string): Promise<ConvertMetadata | null> {
  const convertJsonPath = path.join(convertDir, 'convert.json');

  try {
    const content = await fs.promises.readFile(convertJsonPath, 'utf-8');
    return JSON.parse(content) as ConvertMetadata;
  } catch {
    return null;
  }
}

export async function glbExists(convertedDir: string, urn: string, runId: string): Promise<boolean> {
  const glbPath = path.join(convertedDir, urn, runId, 'model.glb');

  try {
    await fs.promises.access(glbPath);
    return true;
  } catch {
    return false;
  }
}
