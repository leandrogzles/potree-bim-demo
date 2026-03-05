import fs from 'fs';
import path from 'path';
import { ModelDerivativeClient, ManifestHelper, IDerivativeResourceChild } from 'forge-server-utils';
import { SvfReader, GltfWriter } from 'forge-convert-utils';
import { optimizeGlb, getGlbStats } from './optimize';
import { withConversionLock } from './lock';
import type { ConversionQuality, ConvertMetadata, ConvertLogEntry } from '../aps/types';

type DerivativeWithMime = IDerivativeResourceChild & { mime?: string; name?: string; guid: string };

export interface ForgeConvertOptions {
  quality?: ConversionQuality;
  skipOptimization?: boolean;
  viewName?: string;
  outputName?: string;
  log?: boolean;
}

export interface ForgeConvertResult {
  success: boolean;
  outputFile: string;
  glbUrl: string;
  viewableGuid: string;
  viewableName: string;
  outputBytes: number;
  meshCount: number;
  materialCount: number;
  durationMs: number;
  optimizations: string[];
  error?: string;
}

import { getApsToken } from '../aps/auth';

interface ForgeAuth {
  token: string;
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
    console.log(`[ForgeConvert:${phase}] ${message}${durationMs ? ` (${durationMs}ms)` : ''}`);
  };
}

async function getAuth(): Promise<ForgeAuth> {
  const token = await getApsToken();
  return { token };
}

export async function convertFromDerivativeService(
  urn: string,
  outputDir: string,
  runId: string,
  options: ForgeConvertOptions = {}
): Promise<ForgeConvertResult> {
  const {
    quality = 'balanced',
    skipOptimization = false,
    viewName,
    outputName = 'model.glb',
    log: enableLog = false,
  } = options;

  return withConversionLock(urn, runId, async () => {
    const startTime = Date.now();
    const logs: ConvertLogEntry[] = [];
    const log = createLogger(logs);

    log('init', `Starting direct conversion from APS for URN: ${urn.substring(0, 50)}...`);
    log('init', `Run ID: ${runId}`);
    log('init', `Quality: ${quality}`);
    if (viewName) log('init', `Target view: ${viewName}`);

    try {
      const auth = await getAuth();
      log('auth', 'Token acquired');

      log('manifest', 'Fetching manifest from APS Model Derivative service...');
      const manifestStart = Date.now();
      const modelDerivativeClient = new ModelDerivativeClient(auth);
      const manifest = await modelDerivativeClient.getManifest(urn);
      log('manifest', 'Manifest fetched', Date.now() - manifestStart);

      const manifestHelper = new ManifestHelper(manifest);
      const derivatives = manifestHelper.search({ type: 'resource', role: 'graphics' }) as DerivativeWithMime[];

      const svfDerivatives = derivatives.filter(
        (d) => d.mime === 'application/autodesk-svf'
      );

      if (svfDerivatives.length === 0) {
        throw new Error(
          'No SVF derivatives found. The model may only have SVF2. ' +
          'Use ensureSvf1Derivative() to generate SVF1 first.'
        );
      }

      log('manifest', `Found ${svfDerivatives.length} SVF viewable(s)`);

      let targetDerivative = svfDerivatives[0];

      if (viewName) {
        const named = svfDerivatives.find(
          (d) => d.name && d.name.includes(viewName)
        );
        if (named) {
          targetDerivative = named;
          log('manifest', `Selected viewable by name: ${targetDerivative.name}`);
        } else {
          log('manifest', `View "${viewName}" not found, using first viewable: ${targetDerivative.name || targetDerivative.guid}`);
        }
      } else {
        log('manifest', `Using viewable: ${targetDerivative.name || targetDerivative.guid}`);
      }

      await fs.promises.mkdir(outputDir, { recursive: true });

      log('read', 'Reading SVF from APS Derivative Service (this downloads all required assets)...');
      const readStart = Date.now();

      const readerOptions: { log?: typeof console.log } = {};
      if (enableLog) {
        readerOptions.log = console.log;
      }

      const reader = await SvfReader.FromDerivativeService(urn, targetDerivative.guid, auth);
      const scene = await reader.read(readerOptions);
      log('read', 'SVF read complete', Date.now() - readStart);

      const gltfTempDir = path.join(outputDir, 'gltf_temp');
      const finalGlbPath = path.join(outputDir, outputName);

      await fs.promises.mkdir(gltfTempDir, { recursive: true });

      log('write', 'Writing glTF (intermediate)...');
      const writeStart = Date.now();

      const writerOptions: { deduplicate?: boolean; skipUnusedUvs?: boolean; center?: boolean; log?: typeof console.log } = {
        deduplicate: false,
        skipUnusedUvs: true,
        center: false,
      };
      if (enableLog) {
        writerOptions.log = console.log;
      }

      const writer = new GltfWriter(writerOptions);
      await writer.write(scene, gltfTempDir);
      log('write', 'glTF write complete', Date.now() - writeStart);

      const gltfPath = path.join(gltfTempDir, 'output.gltf');

      let outputBytes: number;
      let optimizations: string[] = [];

      log('convert', 'Converting glTF to optimized GLB...');
      const convertStart = Date.now();

      if (!skipOptimization) {
        const optimizeResult = await optimizeGlb(gltfPath, finalGlbPath, quality);
        optimizations = optimizeResult.optimizationsApplied;
        outputBytes = optimizeResult.outputBytes;

        log('optimize', 'Optimization complete', Date.now() - convertStart);
      } else {
        const { NodeIO } = await import('@gltf-transform/core');
        const { unpartition } = await import('@gltf-transform/functions');
        const io = new NodeIO();
        const document = await io.read(gltfPath);
        
        // Consolidate buffers for GLB format
        const bufferCount = document.getRoot().listBuffers().length;
        if (bufferCount > 1) {
          log('convert', `Consolidating ${bufferCount} buffers into one...`);
          await document.transform(unpartition());
        }
        
        const outputBuffer = await io.writeBinary(document);
        await fs.promises.writeFile(finalGlbPath, outputBuffer);
        outputBytes = outputBuffer.length;
        log('convert', 'GLB write complete (no optimization)', Date.now() - convertStart);
      }

      await fs.promises.rm(gltfTempDir, { recursive: true, force: true }).catch(() => {});

      log('stats', 'Collecting GLB statistics...');
      const stats = await getGlbStats(finalGlbPath);

      const durationMs = Date.now() - startTime;
      log('complete', `Conversion successful in ${durationMs}ms`);

      const glbUrl = `/assets/models/${encodeURIComponent(urn)}/${encodeURIComponent(runId)}/model.glb`;

      const metadata: ConvertMetadata = {
        urn,
        downloadRunId: runId,
        inputDir: 'APS Derivative Service (direct)',
        outputFile: finalGlbPath,
        startedAt: new Date(startTime).toISOString(),
        completedAt: new Date().toISOString(),
        quality,
        success: true,
        meshCount: stats.meshCount,
        materialCount: stats.materialCount,
        inputBytes: 0,
        outputBytes,
        durationMs,
        optimizations,
        logs,
      };

      const convertJsonPath = path.join(outputDir, 'convert.json');
      await fs.promises.writeFile(convertJsonPath, JSON.stringify(metadata, null, 2));

      return {
        success: true,
        outputFile: finalGlbPath,
        glbUrl,
        viewableGuid: targetDerivative.guid,
        viewableName: targetDerivative.name || targetDerivative.guid,
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
        downloadRunId: runId,
        inputDir: 'APS Derivative Service (direct)',
        outputFile: path.join(outputDir, outputName),
        startedAt: new Date(startTime).toISOString(),
        completedAt: new Date().toISOString(),
        quality,
        success: false,
        error: message,
        inputBytes: 0,
        outputBytes: 0,
        durationMs: Date.now() - startTime,
        optimizations: [],
        logs,
      };

      const convertJsonPath = path.join(outputDir, 'convert.json');
      await fs.promises.mkdir(outputDir, { recursive: true });
      await fs.promises.writeFile(convertJsonPath, JSON.stringify(metadata, null, 2));

      return {
        success: false,
        outputFile: path.join(outputDir, outputName),
        glbUrl: '',
        viewableGuid: '',
        viewableName: '',
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

export async function listSvfViewables(urn: string): Promise<Array<{ guid: string; name: string; role: string }>> {
  const auth = await getAuth();
  const modelDerivativeClient = new ModelDerivativeClient(auth);
  const manifest = await modelDerivativeClient.getManifest(urn);
  const manifestHelper = new ManifestHelper(manifest);
  const derivatives = manifestHelper.search({ type: 'resource', role: 'graphics' }) as DerivativeWithMime[];

  return derivatives
    .filter((d) => d.mime === 'application/autodesk-svf')
    .map((d) => ({
      guid: d.guid,
      name: d.name || d.guid,
      role: 'graphics',
    }));
}

export async function checkSvfAvailable(urn: string): Promise<{
  hasSvf: boolean;
  hasSvf2: boolean;
  svfCount: number;
  svf2Count: number;
  viewables: Array<{ guid: string; name: string; mime: string }>;
}> {
  const auth = await getAuth();
  const modelDerivativeClient = new ModelDerivativeClient(auth);
  const manifest = await modelDerivativeClient.getManifest(urn);
  const manifestHelper = new ManifestHelper(manifest);
  const derivatives = manifestHelper.search({ type: 'resource', role: 'graphics' }) as DerivativeWithMime[];

  const svfViewables = derivatives.filter((d) => d.mime === 'application/autodesk-svf');
  const svf2Viewables = derivatives.filter((d) => d.mime === 'application/autodesk-svf2');

  return {
    hasSvf: svfViewables.length > 0,
    hasSvf2: svf2Viewables.length > 0,
    svfCount: svfViewables.length,
    svf2Count: svf2Viewables.length,
    viewables: derivatives.map((d) => ({
      guid: d.guid,
      name: d.name || d.guid,
      mime: d.mime || 'unknown',
    })),
  };
}
