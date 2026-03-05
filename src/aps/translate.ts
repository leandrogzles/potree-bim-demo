import axios from 'axios';
import { getApsToken } from './auth';
import { fetchManifest, analyzeManifest } from './derivative';
import { withRetry, sleep } from '../utils/retry';
import type { Manifest } from './types';

const APS_JOB_URL = 'https://developer.api.autodesk.com/modelderivative/v2/designdata/job';

const POLL_INTERVAL_MS = parseInt(process.env.SVF_POLL_INTERVAL_MS || '5000', 10);
const MAX_POLL_TIME_MS = parseInt(process.env.SVF_POLL_TIMEOUT_MS || '600000', 10);

export type OutputFormat = 'svf' | 'svf2' | 'thumbnail' | 'stl' | 'step' | 'iges' | 'obj';

export interface TranslationJobRequest {
  urn: string;
  outputFormat?: OutputFormat;
  outputFormats?: OutputFormat[];
  views?: ('2d' | '3d')[];
  rootFilename?: string;
  compressedUrn?: boolean;
}

export interface TranslationJobResponse {
  result: string;
  urn: string;
  acceptedJobs?: {
    output: {
      formats: Array<{ type: string }>;
    };
  };
}

export interface TranslationStatus {
  urn: string;
  status: string;
  progress: string;
  hasSvf: boolean;
  hasSvf2: boolean;
  derivatives: Array<{
    outputType: string;
    status: string;
    progress?: string;
  }>;
}

export async function startTranslation(options: TranslationJobRequest): Promise<TranslationJobResponse> {
  const token = await getApsToken();

  const {
    urn,
    outputFormat = 'svf',
    outputFormats,
    views = ['2d', '3d'],
    rootFilename,
    compressedUrn = false,
  } = options;

  const formats = outputFormats || [outputFormat];

  console.log(`[Translate] Starting translation job for URN: ${urn.substring(0, 40)}...`);
  console.log(`[Translate] Output formats: ${formats.join(', ')}`);

  const formatSpecs = formats.map((format) => ({
    type: format,
    views: format === 'svf' || format === 'svf2' ? views : undefined,
  }));

  const payload: {
    input: { urn: string; compressedUrn?: boolean; rootFilename?: string };
    output: { formats: typeof formatSpecs };
  } = {
    input: {
      urn: urn,
    },
    output: {
      formats: formatSpecs,
    },
  };

  if (compressedUrn) {
    payload.input.compressedUrn = true;
  }

  if (rootFilename) {
    payload.input.rootFilename = rootFilename;
  }

  const response = await withRetry(async () => {
    return axios.post<TranslationJobResponse>(APS_JOB_URL, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-ads-force': 'true',
      },
    });
  });

  console.log(`[Translate] Job response: result=${response.data.result}`);
  return response.data;
}

export async function getTranslationStatus(urn: string): Promise<TranslationStatus> {
  const manifest = await fetchManifest(urn);
  const analysis = analyzeManifest(manifest);

  const derivatives: TranslationStatus['derivatives'] = [];

  if (manifest.derivatives) {
    for (const deriv of manifest.derivatives) {
      derivatives.push({
        outputType: deriv.outputType || 'unknown',
        status: deriv.status || 'unknown',
        progress: deriv.progress,
      });
    }
  }

  return {
    urn,
    status: manifest.status || 'unknown',
    progress: manifest.progress || 'unknown',
    hasSvf: analysis.hasSvf,
    hasSvf2: analysis.hasSvf2,
    derivatives,
  };
}

export interface EnsureSvf1Result {
  alreadyExists: boolean;
  jobStarted: boolean;
  manifest: Manifest;
  durationMs: number;
}

export async function startSvf1Translation(urn: string): Promise<TranslationJobResponse> {
  return startTranslation({
    urn,
    outputFormat: 'svf',
    views: ['2d', '3d'],
  });
}

async function waitForSvfDerivative(
  urn: string,
  timeoutMs: number = MAX_POLL_TIME_MS
): Promise<Manifest> {
  const startTime = Date.now();
  let lastProgress = '';
  let pollCount = 0;

  console.log(`[Translate] Polling for SVF derivative (interval: ${POLL_INTERVAL_MS}ms, timeout: ${timeoutMs / 1000}s)...`);

  while (Date.now() - startTime < timeoutMs) {
    pollCount++;
    const manifest = await fetchManifest(urn);
    const analysis = analyzeManifest(manifest);

    if (analysis.hasSvf && analysis.svfDerivative) {
      const svfDeriv = analysis.svfDerivative;
      const progress = svfDeriv.progress || manifest.progress || 'unknown';

      if (progress !== lastProgress) {
        console.log(`[Translate] Poll #${pollCount}: SVF status=${svfDeriv.status}, progress=${progress}`);
        lastProgress = progress;
      }

      if (svfDeriv.status === 'success') {
        if (analysis.svfHasUrns) {
          console.log(`[Translate] SVF derivative ready with URNs!`);
          return manifest;
        } else {
          console.log(`[Translate] SVF status=success but no URNs yet, continuing poll...`);
        }
      }

      if (svfDeriv.status === 'failed') {
        throw new Error(
          `SVF translation failed. Check the model for issues or try a different file format.`
        );
      }
    } else {
      if (pollCount === 1 || pollCount % 12 === 0) {
        console.log(`[Translate] Poll #${pollCount}: SVF derivative not yet visible in manifest`);
      }
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Timeout waiting for SVF derivative after ${timeoutMs / 1000}s (${pollCount} polls). ` +
      `The model may be too large or complex. Try again later.`
  );
}

export async function ensureSvf1Derivative(urn: string): Promise<EnsureSvf1Result> {
  const startTime = Date.now();

  console.log(`[Translate] Checking if SVF1 derivative exists for URN: ${urn.substring(0, 40)}...`);

  let manifest = await fetchManifest(urn);

  if (manifest.status !== 'success' && manifest.status !== 'inprogress') {
    throw new Error(
      `Model not ready for translation. Status: ${manifest.status}. ` +
        `Ensure the model has been successfully uploaded and initially translated.`
    );
  }

  const analysis = analyzeManifest(manifest);

  if (analysis.hasSvf && analysis.svfDerivative) {
    const svfDeriv = analysis.svfDerivative;

    if (svfDeriv.status === 'success' && analysis.svfHasUrns) {
      console.log(`[Translate] SVF1 derivative already exists and has URNs`);
      return {
        alreadyExists: true,
        jobStarted: false,
        manifest,
        durationMs: Date.now() - startTime,
      };
    }

    if (svfDeriv.status === 'inprogress') {
      console.log(`[Translate] SVF1 translation already in progress, waiting...`);
      manifest = await waitForSvfDerivative(urn);
      return {
        alreadyExists: false,
        jobStarted: false,
        manifest,
        durationMs: Date.now() - startTime,
      };
    }
  }

  console.log(`[Translate] No usable SVF1 derivative found, starting translation job...`);
  console.log(`[Translate] Current available: ${analysis.available.join(', ') || 'none'}`);

  await startSvf1Translation(urn);

  console.log(`[Translate] Waiting for SVF1 derivative to be ready...`);
  manifest = await waitForSvfDerivative(urn);

  return {
    alreadyExists: false,
    jobStarted: true,
    manifest,
    durationMs: Date.now() - startTime,
  };
}
