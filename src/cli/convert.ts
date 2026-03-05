#!/usr/bin/env node
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { downloadDerivatives, loadRunMetadata, updateRunMetadata } from '../aps/derivative';
import { ensureSvf1Derivative } from '../aps/translate';
import { convertSvfToGlb } from '../convert/convertToGltf';
import { sanitizeUrn } from '../utils/pathSafe';
import { v4 as uuidv4 } from 'uuid';
import type { ConversionQuality } from '../aps/types';

dotenv.config();

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || './data/downloads';
const CONVERTED_DIR = process.env.CONVERTED_DIR || './data/converted';

function printUsage(): void {
  console.log(`
Usage: npm run convert -- --urn <urn> --run <downloadRunId> [--quality balanced]

Options:
  --urn <urn>          Base64-URL-safe URN of the model
  --run <runId>        Download run ID from the download step
  --quality <level>    Optimization quality: fast, balanced, small (default: balanced)
  --skip-optimize      Skip GLB optimization step
  --help               Show this help message

Examples:
  npm run convert -- --urn dXJuOmFkc2... --run abc123-def456
  npm run convert -- --urn dXJuOmFkc2... --run abc123 --quality small
  `);
}

function parseArgs(args: string[]): {
  urn?: string;
  run?: string;
  quality: ConversionQuality;
  skipOptimize: boolean;
  help: boolean;
} {
  const result: {
    urn?: string;
    run?: string;
    quality: ConversionQuality;
    skipOptimize: boolean;
    help: boolean;
  } = {
    quality: 'balanced',
    skipOptimize: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '--urn':
        result.urn = args[++i];
        break;
      case '--run':
        result.run = args[++i];
        break;
      case '--quality':
        const q = args[++i] as ConversionQuality;
        if (['fast', 'balanced', 'small'].includes(q)) {
          result.quality = q;
        } else {
          console.error(`Invalid quality: ${q}. Use fast, balanced, or small.`);
          process.exit(1);
        }
        break;
      case '--skip-optimize':
        result.skipOptimize = true;
        break;
      case '--help':
      case '-h':
        result.help = true;
        break;
    }
  }

  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  if (!args.urn) {
    console.error('Error: --urn is required');
    printUsage();
    process.exit(1);
  }

  if (!args.run) {
    console.error('Error: --run is required');
    printUsage();
    process.exit(1);
  }

  const { urn, run: downloadRunId, quality, skipOptimize } = args;
  const safeUrn = sanitizeUrn(urn);
  const runDir = path.join(DOWNLOAD_DIR, safeUrn, downloadRunId);

  console.log('═'.repeat(60));
  console.log('SVF to GLB Converter');
  console.log('═'.repeat(60));
  console.log(`URN: ${urn.substring(0, 50)}...`);
  console.log(`Download Run ID: ${downloadRunId}`);
  console.log(`Quality: ${quality}`);
  console.log(`Skip Optimization: ${skipOptimize}`);
  console.log('─'.repeat(60));

  let runMetadata;
  try {
    runMetadata = await loadRunMetadata(runDir);
    console.log(`✓ Found run metadata`);
    console.log(`  Derivative type: ${runMetadata.actualDownload}`);
    console.log(`  Downloaded at: ${runMetadata.downloadedAt}`);
    console.log(`  Files: ${runMetadata.files.length}`);
  } catch (error) {
    console.error(`✗ Error loading run metadata from ${runDir}`);
    console.error(`  Run the download step first: POST /api/download-derivative`);
    process.exit(1);
  }

  const startTime = Date.now();
  let svfRunDir = runDir;
  let svfRunId = downloadRunId;

  if (runMetadata.actualDownload === 'svf2') {
    console.log('─'.repeat(60));
    console.log('SVF2 detected - need SVF1 for conversion');

    if (runMetadata.svf1RunId) {
      console.log(`✓ SVF1 already downloaded: ${runMetadata.svf1RunId}`);
      svfRunId = runMetadata.svf1RunId;
      svfRunDir = path.join(DOWNLOAD_DIR, safeUrn, svfRunId);
    } else {
      console.log('Ensuring SVF1 derivative exists...');
      const ensureResult = await ensureSvf1Derivative(urn);

      if (ensureResult.alreadyExists) {
        console.log(`✓ SVF1 derivative already existed`);
      } else if (ensureResult.jobStarted) {
        console.log(`✓ SVF1 translation job completed (${ensureResult.durationMs}ms)`);
      } else {
        console.log(`✓ SVF1 translation was already in progress, now complete`);
      }

      console.log('Downloading SVF1 derivative...');
      svfRunId = uuidv4();
      const svfDownload = await downloadDerivatives({
        urn,
        preference: 'svf',
        outputBaseDir: DOWNLOAD_DIR,
        downloadRunId: svfRunId,
      });

      svfRunDir = svfDownload.outputDir;
      await updateRunMetadata(runDir, { svf1RunId: svfRunId });

      console.log(
        `✓ SVF1 downloaded: ${svfDownload.successCount} files, ` +
          `${(svfDownload.totalBytes / 1024 / 1024).toFixed(2)} MB`
      );
    }
  }

  console.log('─'.repeat(60));
  console.log('Converting SVF to GLB...');

  const outputDir = path.join(CONVERTED_DIR, safeUrn, svfRunId);
  const outputFile = path.join(outputDir, 'model.glb');

  const result = await convertSvfToGlb(svfRunDir, outputFile, urn, svfRunId, {
    quality,
    skipOptimization: skipOptimize,
    log: false,
  });

  console.log('─'.repeat(60));

  if (result.success) {
    const totalDuration = Date.now() - startTime;

    console.log('✓ Conversion successful!');
    console.log('');
    console.log('Output:');
    console.log(`  GLB file: ${result.outputFile}`);
    console.log(`  GLB URL:  ${result.glbUrl}`);
    console.log(`  Size:     ${(result.outputBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  Meshes:   ${result.meshCount}`);
    console.log(`  Materials: ${result.materialCount}`);
    console.log(`  Optimizations: ${result.optimizations.join(', ') || 'none'}`);
    console.log(`  Duration: ${totalDuration}ms`);
    console.log('');
    console.log('To view in Potree:');
    console.log(`  http://localhost:3000/viewer?urn=${encodeURIComponent(urn)}&run=${svfRunId}`);
  } else {
    console.error('✗ Conversion failed!');
    console.error(`  Error: ${result.error}`);
    process.exit(1);
  }

  console.log('═'.repeat(60));
}

main().catch((error) => {
  console.error('Fatal error:', error.message);
  process.exit(1);
});
