import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';

export interface ConvertOptions {
  timeout?: number;
  generatePage?: boolean;
}

export interface ConvertResult {
  success: boolean;
  cloudId: string;
  cloudJsUrl: string;
  outDir: string;
  cached: boolean;
  durationMs: number;
  pointCount?: number;
  error?: string;
  stderr?: string;
}

interface ConvertMetadata {
  cloudId: string;
  rawFile: string;
  hash: string;
  convertedAt: string;
  durationMs: number;
  pointCount?: number;
  potreeConverterVersion?: string;
  stdout?: string;
  stderr?: string;
  error?: string;
}

const RAW_EXTENSIONS = ['.las', '.laz', '.e57', '.ply', '.xyz', '.pts'];
const activeConversions = new Map<string, Promise<ConvertResult>>();

export function isRawPointCloudFile(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return RAW_EXTENSIONS.includes(ext);
}

export async function calculateFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex').substring(0, 16)));
    stream.on('error', reject);
  });
}

function sanitizeCloudId(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 50);
}

function getPotreeConverterPath(): string {
  return process.env.POTREE_CONVERTER_PATH || 'PotreeConverter';
}

async function checkPotreeConverterAvailable(): Promise<{ available: boolean; version?: string; error?: string }> {
  const converterPath = getPotreeConverterPath();
  
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    
    const proc = spawn(converterPath, ['--help'], {
      shell: isWindows,
      timeout: 10000,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('error', (err) => {
      resolve({
        available: false,
        error: `PotreeConverter not found at "${converterPath}". ${err.message}`,
      });
    });

    proc.on('close', (code) => {
      if (code === 0 || stdout.includes('PotreeConverter') || stderr.includes('PotreeConverter')) {
        const versionMatch = (stdout + stderr).match(/version[:\s]+(\d+\.\d+\.\d+)/i);
        resolve({
          available: true,
          version: versionMatch ? versionMatch[1] : 'unknown',
        });
      } else {
        resolve({
          available: false,
          error: `PotreeConverter failed with code ${code}`,
        });
      }
    });
  });
}

async function runPotreeConverter(
  inputPath: string,
  outputDir: string,
  options: ConvertOptions = {}
): Promise<{ success: boolean; stdout: string; stderr: string; code: number | null }> {
  const { timeout = 600000 } = options;
  const converterPath = getPotreeConverterPath();
  const isWindows = process.platform === 'win32';

  const args = [inputPath, '-o', outputDir];

  console.log(`[PotreeConverter] Running: ${converterPath} ${args.join(' ')}`);

  return new Promise((resolve) => {
    const proc = spawn(converterPath, args, {
      shell: isWindows,
      timeout,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      process.stdout.write(`[PotreeConverter] ${text}`);
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      process.stderr.write(`[PotreeConverter:err] ${text}`);
    });

    proc.on('error', (err) => {
      console.error(`[PotreeConverter] Process error:`, err);
      resolve({
        success: false,
        stdout,
        stderr: stderr + `\nProcess error: ${err.message}`,
        code: null,
      });
    });

    proc.on('close', (code) => {
      console.log(`[PotreeConverter] Process exited with code: ${code}`);
      resolve({
        success: code === 0,
        stdout,
        stderr,
        code,
      });
    });
  });
}

async function findPotreeOutput(outDir: string): Promise<{ found: boolean; cloudJsPath: string; cloudJsUrl: string; format: 'v1' | 'v2' }> {
  const cloudId = path.basename(outDir);
  
  const cloudJsPath = path.join(outDir, 'cloud.js');
  try {
    await fs.promises.access(cloudJsPath);
    const url = `/pointclouds/${cloudId}/cloud.js`.replace(/\\/g, '/');
    console.log(`[PotreeOutput] Found cloud.js at: ${cloudJsPath}`);
    console.log(`[PotreeOutput] URL: ${url}`);
    return {
      found: true,
      cloudJsPath,
      cloudJsUrl: url,
      format: 'v1',
    };
  } catch {
    // Not v1 format
  }

  const metadataPath = path.join(outDir, 'metadata.json');
  try {
    await fs.promises.access(metadataPath);
    const url = `/pointclouds/${cloudId}/metadata.json`.replace(/\\/g, '/');
    console.log(`[PotreeOutput] Found metadata.json at: ${metadataPath}`);
    console.log(`[PotreeOutput] URL: ${url}`);
    return {
      found: true,
      cloudJsPath: metadataPath,
      cloudJsUrl: url,
      format: 'v2',
    };
  } catch {
    // Not in root
  }

  try {
    const entries = await fs.promises.readdir(outDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subMetadata = path.join(outDir, entry.name, 'metadata.json');
        try {
          await fs.promises.access(subMetadata);
          const url = `/pointclouds/${cloudId}/${entry.name}/metadata.json`.replace(/\\/g, '/');
          console.log(`[PotreeOutput] Found metadata.json in subdir: ${subMetadata}`);
          console.log(`[PotreeOutput] URL: ${url}`);
          return {
            found: true,
            cloudJsPath: subMetadata,
            cloudJsUrl: url,
            format: 'v2',
          };
        } catch {
          // Continue searching
        }
      }
    }
  } catch {
    // readdir failed
  }

  try {
    const pointcloudsDir = path.join(outDir, 'pointclouds');
    const entries = await fs.promises.readdir(pointcloudsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subMetadata = path.join(pointcloudsDir, entry.name, 'metadata.json');
        try {
          await fs.promises.access(subMetadata);
          const url = `/pointclouds/${cloudId}/pointclouds/${entry.name}/metadata.json`.replace(/\\/g, '/');
          console.log(`[PotreeOutput] Found metadata.json in pointclouds subdir: ${subMetadata}`);
          console.log(`[PotreeOutput] URL: ${url}`);
          return {
            found: true,
            cloudJsPath: subMetadata,
            cloudJsUrl: url,
            format: 'v2',
          };
        } catch {
          // Continue searching
        }
      }
    }
  } catch {
    // pointclouds dir doesn't exist
  }

  console.log(`[PotreeOutput] No valid output found in: ${outDir}`);
  return { found: false, cloudJsPath: '', cloudJsUrl: '', format: 'v1' };
}

export async function ensurePotreePointCloud(
  rawFilePath: string,
  outputBaseDir: string,
  cacheDir: string,
  options: ConvertOptions = {}
): Promise<ConvertResult> {
  const startTime = Date.now();
  const rawFileName = path.basename(rawFilePath);
  const fileBase = path.basename(rawFilePath, path.extname(rawFilePath));

  console.log(`[PointCloud] Ensuring Potree conversion for: ${rawFileName}`);

  const converterCheck = await checkPotreeConverterAvailable();
  if (!converterCheck.available) {
    const installInstructions = `
PotreeConverter is not available.

To install:
1. Download from: https://github.com/potree/PotreeConverter/releases
2. Extract to a folder (e.g., C:\\Tools\\PotreeConverter)
3. Set POTREE_CONVERTER_PATH in .env:
   POTREE_CONVERTER_PATH=C:\\Tools\\PotreeConverter\\PotreeConverter.exe
   Or add the folder to your system PATH.

For Linux/Mac:
  git clone https://github.com/potree/PotreeConverter.git
  cd PotreeConverter && mkdir build && cd build
  cmake .. && make
  # Add to PATH or set POTREE_CONVERTER_PATH
`;
    return {
      success: false,
      cloudId: '',
      cloudJsUrl: '',
      outDir: '',
      cached: false,
      durationMs: Date.now() - startTime,
      error: converterCheck.error + installInstructions,
    };
  }

  console.log(`[PointCloud] PotreeConverter version: ${converterCheck.version}`);

  const hash = await calculateFileHash(rawFilePath);
  const cloudId = `${sanitizeCloudId(fileBase)}_${hash}`;
  const lockKey = cloudId;

  if (activeConversions.has(lockKey)) {
    console.log(`[PointCloud] Waiting for existing conversion: ${lockKey}`);
    return activeConversions.get(lockKey)!;
  }

  const conversionPromise = doConversion();
  activeConversions.set(lockKey, conversionPromise);

  try {
    return await conversionPromise;
  } finally {
    activeConversions.delete(lockKey);
  }

  async function doConversion(): Promise<ConvertResult> {
    const outDir = path.join(outputBaseDir, cloudId);
    const cacheMetadataDir = path.join(cacheDir, cloudId);
    const metadataPath = path.join(cacheMetadataDir, 'convert.json');
    const logPath = path.join(cacheMetadataDir, 'convert.log');

    const existingOutput = await findPotreeOutput(outDir);
    if (existingOutput.found) {
      console.log(`[PointCloud] Using cached conversion: ${cloudId} (format: ${existingOutput.format})`);

      let pointCount: number | undefined;
      try {
        const metadata: ConvertMetadata = JSON.parse(
          await fs.promises.readFile(metadataPath, 'utf-8')
        );
        pointCount = metadata.pointCount;
      } catch {
        // metadata not available
      }

      return {
        success: true,
        cloudId,
        cloudJsUrl: existingOutput.cloudJsUrl,
        outDir,
        cached: true,
        durationMs: Date.now() - startTime,
        pointCount,
      };
    }

    await fs.promises.mkdir(outDir, { recursive: true });
    await fs.promises.mkdir(cacheMetadataDir, { recursive: true });

    console.log(`[PointCloud] Starting conversion: ${rawFileName} -> ${cloudId}`);
    const convertResult = await runPotreeConverter(rawFilePath, outDir, options);

    await fs.promises.writeFile(
      logPath,
      `STDOUT:\n${convertResult.stdout}\n\nSTDERR:\n${convertResult.stderr}`
    );

    if (!convertResult.success) {
      const errorMsg =
        convertResult.stderr.includes('not recognized') ||
        convertResult.stderr.includes('not found') ||
        convertResult.code === null
          ? 'PotreeConverter execution failed. Check convert.log for details.'
          : `PotreeConverter failed with code ${convertResult.code}`;

      const metadata: ConvertMetadata = {
        cloudId,
        rawFile: rawFilePath,
        hash,
        convertedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        stdout: convertResult.stdout.substring(0, 5000),
        stderr: convertResult.stderr.substring(0, 5000),
        error: errorMsg,
      };
      await fs.promises.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

      return {
        success: false,
        cloudId,
        cloudJsUrl: '',
        outDir,
        cached: false,
        durationMs: Date.now() - startTime,
        error: errorMsg,
        stderr: convertResult.stderr.substring(0, 1000),
      };
    }

    const output = await findPotreeOutput(outDir);
    if (!output.found) {
      const errorMsg = 'Conversion completed but no Potree output (cloud.js or metadata.json) was found. Check convert.log.';

      const metadata: ConvertMetadata = {
        cloudId,
        rawFile: rawFilePath,
        hash,
        convertedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        stdout: convertResult.stdout.substring(0, 5000),
        stderr: convertResult.stderr.substring(0, 5000),
        error: errorMsg,
      };
      await fs.promises.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

      return {
        success: false,
        cloudId,
        cloudJsUrl: '',
        outDir,
        cached: false,
        durationMs: Date.now() - startTime,
        error: errorMsg,
      };
    }

    console.log(`[PointCloud] Found output: ${output.cloudJsUrl} (format: ${output.format})`);

    let pointCount: number | undefined;
    const pointCountMatch = convertResult.stdout.match(/#points:\s*([\d']+)/i);
    if (pointCountMatch) {
      pointCount = parseInt(pointCountMatch[1].replace(/'/g, ''), 10);
    }

    const durationMs = Date.now() - startTime;

    const metadata: ConvertMetadata = {
      cloudId,
      rawFile: rawFilePath,
      hash,
      convertedAt: new Date().toISOString(),
      durationMs,
      pointCount,
      potreeConverterVersion: converterCheck.version,
      stdout: convertResult.stdout.substring(0, 5000),
      stderr: convertResult.stderr.substring(0, 5000),
    };
    await fs.promises.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

    console.log(`[PointCloud] Conversion complete: ${cloudId} (${durationMs}ms)`);
    if (pointCount) {
      console.log(`[PointCloud] Point count: ${pointCount.toLocaleString()}`);
    }

    return {
      success: true,
      cloudId,
      cloudJsUrl: output.cloudJsUrl,
      outDir,
      cached: false,
      durationMs,
      pointCount,
    };
  }
}

export interface PointCloudInfo {
  id: string;
  type: 'potree' | 'raw';
  name: string;
  status: 'ready' | 'needs_convert' | 'converting' | 'error';
  cloudJs?: string;
  rawPath?: string;
  rawFileName?: string;
  bytes?: number;
  pointCount?: number;
  convertedAt?: string;
  error?: string;
}

export async function listPointClouds(
  potreeDir: string,
  rawDir: string,
  cacheDir: string
): Promise<PointCloudInfo[]> {
  const clouds: PointCloudInfo[] = [];
  const rawToConvertedMap = new Map<string, string>();

  try {
    const potreeDirs = await fs.promises.readdir(potreeDir, { withFileTypes: true });

    for (const dir of potreeDirs) {
      if (!dir.isDirectory()) continue;

      const cloudId = dir.name;
      const cloudDir = path.join(potreeDir, cloudId);
      
      const output = await findPotreeOutput(cloudDir);
      if (!output.found) continue;

      let pointCount: number | undefined;
      let convertedAt: string | undefined;
      let rawFile: string | undefined;

      try {
        const metadataPath = path.join(cacheDir, cloudId, 'convert.json');
        const metadata: ConvertMetadata = JSON.parse(
          await fs.promises.readFile(metadataPath, 'utf-8')
        );
        pointCount = metadata.pointCount;
        convertedAt = metadata.convertedAt;
        rawFile = metadata.rawFile;

        if (rawFile) {
          rawToConvertedMap.set(path.basename(rawFile), cloudId);
        }
      } catch {
        // metadata not available
      }

      clouds.push({
        id: `pc:potree:${cloudId}`,
        type: 'potree',
        name: cloudId,
        status: 'ready',
        cloudJs: output.cloudJsUrl,
        pointCount,
        convertedAt,
      });
    }
  } catch (err) {
    console.warn('[PointCloud] Could not read potree directory:', err);
  }

  try {
    const rawFiles = await fs.promises.readdir(rawDir, { withFileTypes: true });

    for (const file of rawFiles) {
      if (!file.isFile()) continue;
      if (!isRawPointCloudFile(file.name)) continue;

      const rawFileName = file.name;
      const rawFilePath = path.join(rawDir, rawFileName);

      const alreadyConverted = rawToConvertedMap.get(rawFileName);
      if (alreadyConverted) {
        continue;
      }

      let bytes: number | undefined;
      try {
        const stat = await fs.promises.stat(rawFilePath);
        bytes = stat.size;
      } catch {
        // stat failed
      }

      clouds.push({
        id: `pc:raw:${path.basename(rawFileName, path.extname(rawFileName))}`,
        type: 'raw',
        name: rawFileName,
        status: 'needs_convert',
        rawPath: rawFilePath,
        rawFileName,
        bytes,
      });
    }
  } catch (err) {
    console.warn('[PointCloud] Could not read raw pointclouds directory:', err);
  }

  clouds.sort((a, b) => {
    if (a.status === 'ready' && b.status !== 'ready') return -1;
    if (a.status !== 'ready' && b.status === 'ready') return 1;
    return a.name.localeCompare(b.name);
  });

  return clouds;
}

export async function findRawFileByName(rawDir: string, fileName: string): Promise<string | null> {
  const fullPath = path.join(rawDir, fileName);
  try {
    await fs.promises.access(fullPath);
    return fullPath;
  } catch {
    return null;
  }
}

export async function findRawFileById(rawDir: string, id: string): Promise<string | null> {
  const match = id.match(/^pc:raw:(.+)$/);
  if (!match) return null;

  const fileBase = match[1];

  try {
    const files = await fs.promises.readdir(rawDir);
    for (const file of files) {
      const base = path.basename(file, path.extname(file));
      if (base === fileBase && isRawPointCloudFile(file)) {
        return path.join(rawDir, file);
      }
    }
  } catch {
    // directory doesn't exist
  }

  return null;
}
