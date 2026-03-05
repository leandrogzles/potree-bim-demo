const activeLocks = new Map<string, Promise<void>>();

export function getLockKey(urn: string, runId: string): string {
  return `${urn}:${runId}`;
}

export async function withConversionLock<T>(
  urn: string,
  runId: string,
  fn: () => Promise<T>
): Promise<T> {
  const key = getLockKey(urn, runId);

  while (activeLocks.has(key)) {
    console.log(`[Lock] Waiting for existing conversion: ${key.substring(0, 40)}...`);
    await activeLocks.get(key);
  }

  let releaseLock: () => void;
  const lockPromise = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  activeLocks.set(key, lockPromise);
  console.log(`[Lock] Acquired lock for: ${key.substring(0, 40)}...`);

  try {
    return await fn();
  } finally {
    activeLocks.delete(key);
    releaseLock!();
    console.log(`[Lock] Released lock for: ${key.substring(0, 40)}...`);
  }
}

export function isLocked(urn: string, runId: string): boolean {
  return activeLocks.has(getLockKey(urn, runId));
}

export function getActiveLocks(): string[] {
  return Array.from(activeLocks.keys());
}
