export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableStatusCodes: number[];
}

export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  retryableStatusCodes: [429, 500, 502, 503, 504],
};

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function calculateBackoff(attempt: number, options: RetryOptions): number {
  const delay = options.baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * 0.3 * delay;
  return Math.min(delay + jitter, options.maxDelayMs);
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error as Error;

      const statusCode = (error as { response?: { status?: number } })?.response?.status;
      const isRetryable = statusCode && opts.retryableStatusCodes.includes(statusCode);

      if (attempt < opts.maxRetries && isRetryable) {
        const delay = calculateBackoff(attempt, opts);
        console.log(
          `[Retry] Attempt ${attempt + 1}/${opts.maxRetries} failed with status ${statusCode}, ` +
            `retrying in ${Math.round(delay)}ms...`
        );
        await sleep(delay);
      } else {
        break;
      }
    }
  }

  throw lastError;
}
