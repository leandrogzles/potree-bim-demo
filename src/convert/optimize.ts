import { Document, NodeIO } from '@gltf-transform/core';
import { weld, dedup, prune, quantize, unpartition } from '@gltf-transform/functions';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import fs from 'fs';
import type { ConversionQuality } from '../aps/types';

export interface OptimizeOptions {
  quality: ConversionQuality;
  weld?: boolean;
  dedup?: boolean;
  prune?: boolean;
  quantize?: boolean;
}

export interface OptimizeResult {
  inputBytes: number;
  outputBytes: number;
  optimizationsApplied: string[];
  durationMs: number;
}

function getQualityPreset(quality: ConversionQuality): OptimizeOptions {
  switch (quality) {
    case 'fast':
      return {
        quality,
        weld: false,
        dedup: false,
        prune: true,
        quantize: false,
      };

    case 'balanced':
      return {
        quality,
        weld: true,
        dedup: true,
        prune: true,
        quantize: false,
      };

    case 'small':
      return {
        quality,
        weld: true,
        dedup: true,
        prune: true,
        quantize: true,
      };

    default:
      return getQualityPreset('balanced');
  }
}

export async function optimizeGlb(
  inputPath: string,
  outputPath: string,
  quality: ConversionQuality
): Promise<OptimizeResult> {
  const startTime = Date.now();
  const options = getQualityPreset(quality);
  const optimizationsApplied: string[] = [];

  console.log(`[Optimize] Reading glTF/GLB from: ${inputPath}`);

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const document: Document = await io.read(inputPath);

  const inputStat = await fs.promises.stat(inputPath);
  const inputBytes = inputStat.size;

  if (options.prune) {
    console.log(`[Optimize] Applying prune...`);
    await document.transform(prune());
    optimizationsApplied.push('prune');
  }

  if (options.dedup) {
    console.log(`[Optimize] Applying dedup...`);
    await document.transform(dedup());
    optimizationsApplied.push('dedup');
  }

  if (options.weld) {
    console.log(`[Optimize] Applying weld...`);
    await document.transform(weld());
    optimizationsApplied.push('weld');
  }

  if (options.quantize) {
    console.log(`[Optimize] Applying quantize...`);
    await document.transform(quantize());
    optimizationsApplied.push('quantize');
  }

  // Consolidate all buffers into one (required for GLB format)
  const bufferCount = document.getRoot().listBuffers().length;
  if (bufferCount > 1) {
    console.log(`[Optimize] Consolidating ${bufferCount} buffers into one...`);
    await document.transform(unpartition());
    optimizationsApplied.push('unpartition');
  }

  console.log(`[Optimize] Writing optimized GLB to: ${outputPath}`);
  const outputBuffer = await io.writeBinary(document);
  await fs.promises.writeFile(outputPath, outputBuffer);

  const outputBytes = outputBuffer.length;
  const durationMs = Date.now() - startTime;

  const reduction = ((1 - outputBytes / inputBytes) * 100).toFixed(1);
  console.log(
    `[Optimize] Complete: ${(inputBytes / 1024 / 1024).toFixed(2)} MB -> ` +
      `${(outputBytes / 1024 / 1024).toFixed(2)} MB (${reduction}% reduction)`
  );

  return {
    inputBytes,
    outputBytes,
    optimizationsApplied,
    durationMs,
  };
}

export async function getGlbStats(glbPath: string): Promise<{ meshCount: number; materialCount: number }> {
  const buffer = await fs.promises.readFile(glbPath);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const document = await io.readBinary(buffer);

  const meshCount = document.getRoot().listMeshes().length;
  const materialCount = document.getRoot().listMaterials().length;

  return { meshCount, materialCount };
}
