import path from 'path';

const UNSAFE_CHARS_REGEX = /[<>:"|?*\x00-\x1f]/g;

export function safePathFromDerivativeUrn(derivativeUrn: string): string {
  let decoded = derivativeUrn;

  try {
    decoded = decodeURIComponent(derivativeUrn);
  } catch {
    // Keep original if decoding fails
  }

  const cleaned = decoded.replace(UNSAFE_CHARS_REGEX, '_');

  const parts = cleaned.split('/').filter(Boolean);
  const safeParts = parts.map((part) => {
    let safe = part.replace(/\.+/g, '.').replace(/^\.+|\.+$/g, '');
    if (safe.length > 200) {
      const ext = path.extname(safe);
      const name = path.basename(safe, ext);
      safe = name.slice(0, 200 - ext.length) + ext;
    }
    return safe || '_';
  });

  return safeParts.join('/');
}

export function ensureExtension(filePath: string, derivativeUrn: string): string {
  const currentExt = path.extname(filePath);
  if (currentExt) return filePath;

  const urnExt = path.extname(derivativeUrn);
  if (urnExt) {
    return filePath + urnExt;
  }

  return filePath;
}

export function sanitizeUrn(urn: string): string {
  return urn.replace(/[\/\\:*?"<>|]/g, '_');
}
