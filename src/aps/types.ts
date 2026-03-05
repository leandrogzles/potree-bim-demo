export interface ApsToken {
  access_token: string;
  token_type: string;
  expires_in: number;
  expiresAt: number;
}

export interface ManifestDerivative {
  name?: string;
  hasThumbnail?: string;
  status: string;
  progress?: string;
  outputType?: string;
  children?: ManifestNode[];
}

export interface ManifestNode {
  guid?: string;
  type?: string;
  role?: string;
  name?: string;
  status?: string;
  progress?: string;
  mime?: string;
  urn?: string;
  outputType?: string;
  children?: ManifestNode[];
  phaseNames?: string;
  hasThumbnail?: string;
  properties?: Record<string, unknown>;
}

export interface Manifest {
  type: string;
  hasThumbnail: string;
  status: string;
  progress: string;
  region: string;
  urn: string;
  version: string;
  derivatives: ManifestDerivative[];
}

export type DerivativePreference = 'svf' | 'svf2' | 'auto';

export interface DerivativeFile {
  urn: string;
  mime?: string;
  role?: string;
  type?: string;
}

export interface DownloadResult {
  localPath: string;
  derivativeUrn: string;
  bytes: number;
  success: boolean;
  error?: string;
}

export interface DownloadJobResult {
  jobId: string;
  urn: string;
  derivativeType: 'svf' | 'svf2';
  outputDir: string;
  filesDownloaded: number;
  filesFailed: number;
  bytesDownloaded: number;
  durationMs: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  error?: string;
  failedFiles?: string[];
  warnings?: string[];
}

export interface DownloadRunFileInfo {
  derivativeUrn: string;
  localPath: string;
  bytes: number;
}

export interface DownloadRunMetadata {
  urn: string;
  downloadRunId: string;
  requested: {
    prefer: DerivativePreference;
    autoGenerateSvf?: boolean;
  };
  available: string[];
  actualDownload: 'svf' | 'svf2';
  svfGenerated: boolean;
  downloadedAt: string;
  files: DownloadRunFileInfo[];
  svf1RunId?: string;
  warnings?: string[];
}

export type ConversionQuality = 'fast' | 'balanced' | 'small';

export interface ConversionJobResult {
  urn: string;
  downloadRunId: string;
  glbPath: string;
  glbUrl: string;
  bytes: number;
  durationMs: number;
  optimizationApplied: string[];
}

export interface ConvertLogEntry {
  phase: string;
  timestamp: string;
  message: string;
  durationMs?: number;
}

export interface ConvertMetadata {
  urn: string;
  downloadRunId: string;
  inputDir: string;
  outputFile: string;
  startedAt: string;
  completedAt: string;
  quality: ConversionQuality;
  success: boolean;
  error?: string;
  meshCount?: number;
  materialCount?: number;
  inputBytes: number;
  outputBytes: number;
  durationMs: number;
  optimizations: string[];
  logs: ConvertLogEntry[];
}
