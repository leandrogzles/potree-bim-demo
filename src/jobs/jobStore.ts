import type { DownloadJobResult } from '../aps/types';

const jobs = new Map<string, DownloadJobResult>();

export function createJob(jobId: string, urn: string): DownloadJobResult {
  const job: DownloadJobResult = {
    jobId,
    urn,
    derivativeType: 'svf',
    outputDir: '',
    filesDownloaded: 0,
    filesFailed: 0,
    bytesDownloaded: 0,
    durationMs: 0,
    status: 'pending',
  };

  jobs.set(jobId, job);
  return job;
}

export function updateJob(jobId: string, updates: Partial<DownloadJobResult>): DownloadJobResult | null {
  const job = jobs.get(jobId);
  if (!job) return null;

  Object.assign(job, updates);
  return job;
}

export function getJob(jobId: string): DownloadJobResult | null {
  return jobs.get(jobId) || null;
}

export function getAllJobs(): DownloadJobResult[] {
  return Array.from(jobs.values());
}

export function deleteJob(jobId: string): boolean {
  return jobs.delete(jobId);
}
