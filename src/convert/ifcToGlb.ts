import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { optimizeGlb } from './optimize';
import type { ConversionQuality } from '../aps/types';

export interface IfcConvertOptions {
  quality?: ConversionQuality;
  skipOptimization?: boolean;
  timeout?: number;
}

export interface IfcConvertResult {
  success: boolean;
  ifcId: string;
  hash: string;
  glbUrl: string;
  outputFile: string;
  outputBytes: number;
  durationMs: number;
  cached: boolean;
  optimizations: string[];
  error?: string;
  stderr?: string;
}

interface ConvertMetadata {
  ifcId: string;
  hash: string;
  inputFile: string;
  outputFile: string;
  inputBytes: number;
  outputBytes: number;
  convertedAt: string;
  durationMs: number;
  cached: boolean;
  ifcConvertVersion?: string;
  optimizations: string[];
  stdout?: string;
  stderr?: string;
  error?: string;
}

const activeConversions = new Map<string, Promise<IfcConvertResult>>();

export async function calculateFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex').substring(0, 16)));
    stream.on('error', reject);
  });
}

async function runIfcConvert(
  ifcPath: string,
  outputPath: string,
  timeout: number
): Promise<{ success: boolean; stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    const ifcConvertCmd = isWindows ? 'IfcConvert.exe' : 'IfcConvert';

    console.log(`[IfcConvert] Running: ${ifcConvertCmd} "${ifcPath}" "${outputPath}"`);

    const proc = spawn(ifcConvertCmd, [ifcPath, outputPath], {
      shell: isWindows,
      timeout,
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
      console.error(`[IfcConvert] Process error:`, err);
      resolve({
        success: false,
        stdout,
        stderr: stderr + `\nProcess error: ${err.message}`,
        code: null,
      });
    });

    proc.on('close', (code) => {
      console.log(`[IfcConvert] Process exited with code: ${code}`);
      resolve({
        success: code === 0,
        stdout,
        stderr,
        code,
      });
    });
  });
}

export async function convertIfcToGlb(
  ifcId: string,
  ifcPath: string,
  outputDir: string,
  options: IfcConvertOptions = {}
): Promise<IfcConvertResult> {
  const { quality = 'balanced', skipOptimization = false, timeout = 300000 } = options;

  const hash = await calculateFileHash(ifcPath);
  const lockKey = `${ifcId}:${hash}`;

  if (activeConversions.has(lockKey)) {
    console.log(`[IfcConvert] Waiting for existing conversion: ${lockKey}`);
    return activeConversions.get(lockKey)!;
  }

  const conversionPromise = doConversion();
  activeConversions.set(lockKey, conversionPromise);

  try {
    return await conversionPromise;
  } finally {
    activeConversions.delete(lockKey);
  }

  async function doConversion(): Promise<IfcConvertResult> {
    const startTime = Date.now();
    const hashDir = path.join(outputDir, ifcId, hash);
    const finalGlbPath = path.join(hashDir, 'model.glb');
    const metadataPath = path.join(hashDir, 'convert.json');
    const glbUrl = `/assets/ifc-models/${encodeURIComponent(ifcId)}/${encodeURIComponent(hash)}/model.glb`;

    console.log(`[IfcConvert] Starting conversion for IFC: ${ifcId}`);
    console.log(`[IfcConvert] Hash: ${hash}`);
    console.log(`[IfcConvert] Output dir: ${hashDir}`);

    try {
      await fs.promises.access(finalGlbPath);
      const stat = await fs.promises.stat(finalGlbPath);
      console.log(`[IfcConvert] Using cached GLB: ${finalGlbPath}`);

      return {
        success: true,
        ifcId,
        hash,
        glbUrl,
        outputFile: finalGlbPath,
        outputBytes: stat.size,
        durationMs: Date.now() - startTime,
        cached: true,
        optimizations: [],
      };
    } catch {
      // Not cached, need to convert
    }

    await fs.promises.mkdir(hashDir, { recursive: true });

    const ifcStat = await fs.promises.stat(ifcPath);
    const inputBytes = ifcStat.size;

    const tempGltfPath = path.join(hashDir, 'temp_output.gltf');

    console.log(`[IfcConvert] Converting IFC to glTF...`);
    const convertResult = await runIfcConvert(ifcPath, tempGltfPath, timeout);

    if (!convertResult.success) {
      const errorMsg = convertResult.stderr.includes('not recognized') ||
                       convertResult.stderr.includes('not found') ||
                       convertResult.code === null
        ? 'IfcConvert not found. Please install IfcOpenShell and add IfcConvert to PATH.'
        : `IfcConvert failed with code ${convertResult.code}: ${convertResult.stderr.substring(0, 500)}`;

      const metadata: ConvertMetadata = {
        ifcId,
        hash,
        inputFile: ifcPath,
        outputFile: finalGlbPath,
        inputBytes,
        outputBytes: 0,
        convertedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        cached: false,
        optimizations: [],
        stdout: convertResult.stdout,
        stderr: convertResult.stderr,
        error: errorMsg,
      };
      await fs.promises.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

      return {
        success: false,
        ifcId,
        hash,
        glbUrl: '',
        outputFile: finalGlbPath,
        outputBytes: 0,
        durationMs: Date.now() - startTime,
        cached: false,
        optimizations: [],
        error: errorMsg,
        stderr: convertResult.stderr,
      };
    }

    let gltfInputPath = tempGltfPath;
    try {
      await fs.promises.access(tempGltfPath);
    } catch {
      const tempGlbPath = path.join(hashDir, 'temp_output.glb');
      try {
        await fs.promises.access(tempGlbPath);
        gltfInputPath = tempGlbPath;
      } catch {
        const files = await fs.promises.readdir(hashDir);
        const gltfFile = files.find(f => f.endsWith('.gltf') || f.endsWith('.glb'));
        if (gltfFile) {
          gltfInputPath = path.join(hashDir, gltfFile);
        } else {
          throw new Error(`IfcConvert did not produce glTF/GLB output. Files in dir: ${files.join(', ')}`);
        }
      }
    }

    console.log(`[IfcConvert] glTF/GLB produced: ${gltfInputPath}`);

    let outputBytes: number;
    let optimizations: string[] = [];

    if (!skipOptimization) {
      console.log(`[IfcConvert] Optimizing GLB with quality: ${quality}`);
      const optimizeResult = await optimizeGlb(gltfInputPath, finalGlbPath, quality);
      outputBytes = optimizeResult.outputBytes;
      optimizations = optimizeResult.optimizationsApplied;
    } else {
      const { NodeIO } = await import('@gltf-transform/core');
      const { unpartition } = await import('@gltf-transform/functions');
      const io = new NodeIO();
      const document = await io.read(gltfInputPath);

      const bufferCount = document.getRoot().listBuffers().length;
      if (bufferCount > 1) {
        console.log(`[IfcConvert] Consolidating ${bufferCount} buffers...`);
        await document.transform(unpartition());
      }

      const outputBuffer = await io.writeBinary(document);
      await fs.promises.writeFile(finalGlbPath, outputBuffer);
      outputBytes = outputBuffer.length;
    }

    const tempFiles = await fs.promises.readdir(hashDir);
    for (const file of tempFiles) {
      if (file.startsWith('temp_') || (file.endsWith('.bin') && file !== 'model.glb')) {
        await fs.promises.unlink(path.join(hashDir, file)).catch(() => {});
      }
    }

    const durationMs = Date.now() - startTime;

    const metadata: ConvertMetadata = {
      ifcId,
      hash,
      inputFile: ifcPath,
      outputFile: finalGlbPath,
      inputBytes,
      outputBytes,
      convertedAt: new Date().toISOString(),
      durationMs,
      cached: false,
      optimizations,
      stdout: convertResult.stdout.substring(0, 2000),
      stderr: convertResult.stderr.substring(0, 2000),
    };
    await fs.promises.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

    console.log(`[IfcConvert] Conversion complete in ${durationMs}ms`);
    console.log(`[IfcConvert] Output: ${finalGlbPath} (${(outputBytes / 1024 / 1024).toFixed(2)} MB)`);

    return {
      success: true,
      ifcId,
      hash,
      glbUrl,
      outputFile: finalGlbPath,
      outputBytes,
      durationMs,
      cached: false,
      optimizations,
    };
  }
}

export async function listIfcModels(ifcDir: string): Promise<Array<{
  ifcId: string;
  name: string;
  ifcPath: string;
  bytes: number;
  modifiedAt: string;
}>> {
  const models: Array<{
    ifcId: string;
    name: string;
    ifcPath: string;
    bytes: number;
    modifiedAt: string;
  }> = [];

  try {
    const entries = await fs.promises.readdir(ifcDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const ifcId = entry.name;
      const ifcPath = path.join(ifcDir, ifcId, 'model.ifc');

      try {
        const stat = await fs.promises.stat(ifcPath);
        models.push({
          ifcId,
          name: ifcId,
          ifcPath,
          bytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        });
      } catch {
        // model.ifc doesn't exist in this folder
      }
    }
  } catch {
    // ifcDir doesn't exist
  }

  return models.sort((a, b) => 
    new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime()
  );
}
