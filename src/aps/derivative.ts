import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getApsToken } from './auth';
import { withRetry } from '../utils/retry';
import { runWithConcurrencyLimit } from '../utils/concurrency';
import { safePathFromDerivativeUrn, sanitizeUrn } from '../utils/pathSafe';
import type {
  Manifest,
  ManifestNode,
  ManifestDerivative,
  DerivativePreference,
  DerivativeFile,
  DownloadResult,
  DownloadRunMetadata,
} from './types';

const APS_BASE_URL = 'https://developer.api.autodesk.com/modelderivative/v2/designdata';
const CONCURRENT_DOWNLOADS = 6;

export async function fetchManifest(urn: string): Promise<Manifest> {
  const token = await getApsToken();
  const url = `${APS_BASE_URL}/${encodeURIComponent(urn)}/manifest`;

  const response = await withRetry(async () => {
    return axios.get<Manifest>(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
  });

  return response.data;
}

export interface ManifestAnalysis {
  hasSvf: boolean;
  hasSvf2: boolean;
  svfDerivative: ManifestDerivative | null;
  svf2Derivative: ManifestDerivative | null;
  svfGraphicsNode: ManifestNode | null;
  svf2GraphicsNode: ManifestNode | null;
  svfHasUrns: boolean;
  svf2HasUrns: boolean;
  available: string[];
}

function findNodeByMimeAndRole(
  node: ManifestNode | ManifestDerivative,
  mime: string,
  role: string
): ManifestNode | null {
  if ('mime' in node && node.mime === mime && node.role === role) {
    return node as ManifestNode;
  }

  if (node.children) {
    for (const child of node.children) {
      const found = findNodeByMimeAndRole(child, mime, role);
      if (found) return found;
    }
  }

  return null;
}

function hasAnyUrn(node: ManifestNode | ManifestDerivative): boolean {
  if ('urn' in node && node.urn && typeof node.urn === 'string') {
    return true;
  }

  if (node.children) {
    for (const child of node.children) {
      if (hasAnyUrn(child)) return true;
    }
  }

  return false;
}

export function analyzeManifest(manifest: Manifest): ManifestAnalysis {
  let svfDerivative: ManifestDerivative | null = null;
  let svf2Derivative: ManifestDerivative | null = null;
  let svfGraphicsNode: ManifestNode | null = null;
  let svf2GraphicsNode: ManifestNode | null = null;

  for (const derivative of manifest.derivatives) {
    if (derivative.status !== 'success') continue;

    if (derivative.outputType === 'svf') {
      svfDerivative = derivative;
      svfGraphicsNode = findNodeByMimeAndRole(
        derivative,
        'application/autodesk-svf',
        'graphics'
      );
    } else if (derivative.outputType === 'svf2') {
      svf2Derivative = derivative;
      svf2GraphicsNode = findNodeByMimeAndRole(
        derivative,
        'application/autodesk-svf2',
        'graphics'
      );
    }
  }

  const hasSvf = svfDerivative !== null;
  const hasSvf2 = svf2Derivative !== null;

  const svfHasUrns = svfDerivative ? hasAnyUrn(svfDerivative) : false;
  const svf2HasUrns = svf2Derivative ? hasAnyUrn(svf2Derivative) : false;

  const available: string[] = [];
  if (hasSvf) available.push('svf');
  if (hasSvf2) available.push('svf2');

  return {
    hasSvf,
    hasSvf2,
    svfDerivative,
    svf2Derivative,
    svfGraphicsNode,
    svf2GraphicsNode,
    svfHasUrns,
    svf2HasUrns,
    available,
  };
}

export function hasSvfDerivative(manifest: Manifest): boolean {
  const analysis = analyzeManifest(manifest);
  return analysis.hasSvf;
}

export function hasSvf2Derivative(manifest: Manifest): boolean {
  const analysis = analyzeManifest(manifest);
  return analysis.hasSvf2;
}

export interface SelectDerivativeResult {
  derivative: ManifestDerivative | null;
  type: 'svf' | 'svf2' | null;
  analysis: ManifestAnalysis;
  needsSvfGeneration: boolean;
  warning?: string;
  error?: string;
}

export function selectDerivativeForDownload(
  manifest: Manifest,
  preference: DerivativePreference,
  autoGenerateSvf: boolean
): SelectDerivativeResult {
  const analysis = analyzeManifest(manifest);
  const { svfDerivative, svf2Derivative, svfHasUrns, svf2HasUrns, hasSvf, hasSvf2 } = analysis;

  console.log(`[Derivative] Analysis: hasSvf=${hasSvf}, hasSvf2=${hasSvf2}, svfHasUrns=${svfHasUrns}, svf2HasUrns=${svf2HasUrns}`);

  if (preference === 'svf') {
    if (hasSvf && svfHasUrns) {
      return {
        derivative: svfDerivative,
        type: 'svf',
        analysis,
        needsSvfGeneration: false,
      };
    }

    if (!hasSvf) {
      if (autoGenerateSvf) {
        return {
          derivative: null,
          type: null,
          analysis,
          needsSvfGeneration: true,
          warning: 'SVF not available; will generate SVF translation job.',
        };
      } else {
        return {
          derivative: null,
          type: null,
          analysis,
          needsSvfGeneration: false,
          error: 'SVF not available; set autoGenerateSvf=true to generate it.',
        };
      }
    }

    if (hasSvf && !svfHasUrns) {
      return {
        derivative: null,
        type: null,
        analysis,
        needsSvfGeneration: false,
        error: 'SVF exists but graphics node has no URNs. Model may be corrupted.',
      };
    }
  }

  if (preference === 'svf2') {
    if (hasSvf2 && svf2HasUrns) {
      return {
        derivative: svf2Derivative,
        type: 'svf2',
        analysis,
        needsSvfGeneration: false,
      };
    }

    if (!hasSvf2) {
      if (hasSvf && svfHasUrns) {
        return {
          derivative: svfDerivative,
          type: 'svf',
          analysis,
          needsSvfGeneration: false,
          warning: 'Requested SVF2, but only SVF available; using SVF.',
        };
      }
      return {
        derivative: null,
        type: null,
        analysis,
        needsSvfGeneration: false,
        error: 'SVF2 not available and no SVF fallback.',
      };
    }

    if (hasSvf2 && !svf2HasUrns) {
      return {
        derivative: null,
        type: null,
        analysis,
        needsSvfGeneration: false,
        error: 'SVF2 graphics not directly listable from manifest (no URNs). Use prefer=svf with autoGenerateSvf=true.',
      };
    }
  }

  if (preference === 'auto') {
    if (hasSvf && svfHasUrns) {
      return {
        derivative: svfDerivative,
        type: 'svf',
        analysis,
        needsSvfGeneration: false,
      };
    }

    if (hasSvf2 && svf2HasUrns) {
      return {
        derivative: svf2Derivative,
        type: 'svf2',
        analysis,
        needsSvfGeneration: false,
      };
    }

    if (hasSvf2 && !svf2HasUrns) {
      if (autoGenerateSvf) {
        return {
          derivative: null,
          type: null,
          analysis,
          needsSvfGeneration: true,
          warning: 'SVF2 has no URNs; will generate SVF translation job.',
        };
      } else {
        return {
          derivative: null,
          type: null,
          analysis,
          needsSvfGeneration: false,
          error: 'Only SVF2 available but graphics not listable. Set autoGenerateSvf=true to generate SVF.',
        };
      }
    }

    return {
      derivative: null,
      type: null,
      analysis,
      needsSvfGeneration: autoGenerateSvf,
      error: autoGenerateSvf ? undefined : 'No suitable derivative found. Set autoGenerateSvf=true.',
      warning: autoGenerateSvf ? 'No derivative available; will generate SVF.' : undefined,
    };
  }

  return {
    derivative: null,
    type: null,
    analysis,
    needsSvfGeneration: false,
    error: 'No suitable derivative found.',
  };
}

export function collectDerivativeFiles(node: ManifestNode | ManifestDerivative): DerivativeFile[] {
  const files: DerivativeFile[] = [];
  const seen = new Set<string>();

  function traverse(n: ManifestNode | ManifestDerivative): void {
    if ('urn' in n && n.urn && typeof n.urn === 'string') {
      if (!seen.has(n.urn)) {
        seen.add(n.urn);
        files.push({
          urn: n.urn,
          mime: 'mime' in n ? n.mime : undefined,
          role: 'role' in n ? n.role : undefined,
          type: 'type' in n ? n.type : undefined,
        });
      }
    }

    if (n.children) {
      for (const child of n.children) {
        traverse(child);
      }
    }
  }

  traverse(node);
  return files;
}

async function downloadSingleFile(
  modelUrn: string,
  derivativeFile: DerivativeFile,
  outputDir: string
): Promise<DownloadResult> {
  const token = await getApsToken();
  const encodedDerivativeUrn = encodeURIComponent(derivativeFile.urn);
  const url = `${APS_BASE_URL}/${encodeURIComponent(modelUrn)}/manifest/${encodedDerivativeUrn}`;

  const localRelativePath = safePathFromDerivativeUrn(derivativeFile.urn);
  const localPath = path.join(outputDir, localRelativePath);

  try {
    await fs.promises.mkdir(path.dirname(localPath), { recursive: true });

    const response = await withRetry(async () => {
      return axios.get(url, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        responseType: 'arraybuffer',
      });
    });

    const buffer = Buffer.from(response.data);
    await fs.promises.writeFile(localPath, buffer);

    return {
      localPath,
      derivativeUrn: derivativeFile.urn,
      bytes: buffer.length,
      success: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Download] Failed to download ${derivativeFile.urn}: ${message}`);

    return {
      localPath,
      derivativeUrn: derivativeFile.urn,
      bytes: 0,
      success: false,
      error: message,
    };
  }
}

export interface DownloadDerivativesOptions {
  urn: string;
  preference: DerivativePreference;
  outputBaseDir: string;
  downloadRunId?: string;
  autoGenerateSvf?: boolean;
  svfGenerated?: boolean;
  manifest?: Manifest;
  onProgress?: (downloaded: number, total: number) => void;
}

export interface DownloadDerivativesResult {
  downloadRunId: string;
  derivativeType: 'svf' | 'svf2';
  outputDir: string;
  files: DownloadResult[];
  totalBytes: number;
  successCount: number;
  failedCount: number;
  failedFiles: string[];
  runMetadata: DownloadRunMetadata;
  warnings: string[];
  needsSvfGeneration?: boolean;
  analysis?: ManifestAnalysis;
}

export async function downloadDerivatives(
  options: DownloadDerivativesOptions
): Promise<DownloadDerivativesResult> {
  const {
    urn,
    preference,
    outputBaseDir,
    onProgress,
    autoGenerateSvf = false,
    svfGenerated = false,
  } = options;
  const downloadRunId = options.downloadRunId || uuidv4();
  const warnings: string[] = [];

  console.log(`[Derivative] Fetching manifest for URN: ${urn.substring(0, 40)}...`);
  const manifest = options.manifest || await fetchManifest(urn);

  if (manifest.status !== 'success') {
    throw new Error(
      `Model translation not complete. Status: ${manifest.status}, Progress: ${manifest.progress}`
    );
  }

  const selection = selectDerivativeForDownload(manifest, preference, autoGenerateSvf);

  if (selection.warning) {
    warnings.push(selection.warning);
    console.log(`[Derivative] Warning: ${selection.warning}`);
  }

  if (selection.needsSvfGeneration) {
    return {
      downloadRunId,
      derivativeType: 'svf',
      outputDir: '',
      files: [],
      totalBytes: 0,
      successCount: 0,
      failedCount: 0,
      failedFiles: [],
      runMetadata: {
        urn,
        downloadRunId,
        requested: { prefer: preference, autoGenerateSvf },
        available: selection.analysis.available,
        actualDownload: 'svf',
        svfGenerated: false,
        downloadedAt: new Date().toISOString(),
        files: [],
        warnings,
      },
      warnings,
      needsSvfGeneration: true,
      analysis: selection.analysis,
    };
  }

  if (selection.error || !selection.derivative || !selection.type) {
    throw new Error(selection.error || 'No suitable derivative found.');
  }

  const { derivative, type, analysis } = selection;

  console.log(`[Derivative] Selected derivative type: ${type}`);

  const files = collectDerivativeFiles(derivative);
  console.log(`[Derivative] Found ${files.length} files to download`);

  if (files.length === 0) {
    throw new Error('No derivative files found in manifest. The model may need re-translation.');
  }

  const safeUrn = sanitizeUrn(urn);
  const outputDir = path.join(outputBaseDir, safeUrn, downloadRunId);

  await fs.promises.mkdir(outputDir, { recursive: true });

  const manifestPath = path.join(outputDir, 'manifest.json');
  await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  let downloadedCount = 0;

  const results = await runWithConcurrencyLimit(files, CONCURRENT_DOWNLOADS, async (file, idx) => {
    const result = await downloadSingleFile(urn, file, outputDir);
    downloadedCount++;

    if (onProgress) {
      onProgress(downloadedCount, files.length);
    }

    if (idx % 10 === 0 || idx === files.length - 1) {
      console.log(`[Derivative] Progress: ${downloadedCount}/${files.length} files`);
    }

    return result;
  });

  const successCount = results.filter((r) => r.success).length;
  const failedCount = results.filter((r) => !r.success).length;
  const totalBytes = results.reduce((sum, r) => sum + r.bytes, 0);
  const failedFiles = results.filter((r) => !r.success).map((r) => r.derivativeUrn);

  const availableWithGenerated = [...analysis.available];
  if (svfGenerated && !availableWithGenerated.includes('svf')) {
    availableWithGenerated.push('svf (generated)');
  }

  const runMetadata: DownloadRunMetadata = {
    urn,
    downloadRunId,
    requested: {
      prefer: preference,
      autoGenerateSvf,
    },
    available: availableWithGenerated,
    actualDownload: type,
    svfGenerated,
    downloadedAt: new Date().toISOString(),
    files: results
      .filter((r) => r.success)
      .map((r) => ({
        derivativeUrn: r.derivativeUrn,
        localPath: path.relative(outputDir, r.localPath),
        bytes: r.bytes,
      })),
    warnings: warnings.length > 0 ? warnings : undefined,
  };

  const runJsonPath = path.join(outputDir, 'run.json');
  await fs.promises.writeFile(runJsonPath, JSON.stringify(runMetadata, null, 2));
  console.log(`[Derivative] Saved run metadata to ${runJsonPath}`);

  return {
    downloadRunId,
    derivativeType: type,
    outputDir,
    files: results,
    totalBytes,
    successCount,
    failedCount,
    failedFiles,
    runMetadata,
    warnings,
    needsSvfGeneration: false,
    analysis,
  };
}

export async function loadRunMetadata(runDir: string): Promise<DownloadRunMetadata> {
  const runJsonPath = path.join(runDir, 'run.json');
  const content = await fs.promises.readFile(runJsonPath, 'utf-8');
  return JSON.parse(content) as DownloadRunMetadata;
}

export async function updateRunMetadata(
  runDir: string,
  updates: Partial<DownloadRunMetadata>
): Promise<DownloadRunMetadata> {
  const current = await loadRunMetadata(runDir);
  const updated = { ...current, ...updates };
  const runJsonPath = path.join(runDir, 'run.json');
  await fs.promises.writeFile(runJsonPath, JSON.stringify(updated, null, 2));
  return updated;
}
