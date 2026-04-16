/**
 * Path validation for `functions/v1/[[route]].ts` (Cloudflare Pages proxy).
 * Rejects traversal (`..`), encoded slashes, and other segments that would escape `/v1/`.
 */

function hasAsciiControlOrDel(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

/** Single-segment decode; returns null on invalid % sequences. */
export function decodePathSegmentOnce(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** Decode until stable (nested `%25` / `%2e` tricks). */
function fullyDecodePathSegment(raw: string, maxRounds = 8): string | null {
  let current = raw;
  for (let i = 0; i < maxRounds; i++) {
    const next = decodePathSegmentOnce(current);
    if (next === null) return null;
    if (next === current) return next;
    current = next;
  }
  return null;
}

export function isSafeCfPagesV1ProxyPathSuffix(pathSuffix: string): boolean {
  if (pathSuffix === '') return true;
  const segments = pathSuffix.split('/');
  for (const raw of segments) {
    if (raw === '') return false;
    const decoded = fullyDecodePathSegment(raw);
    if (decoded === null) return false;
    if (decoded === '' || decoded === '.' || decoded === '..') return false;
    if (decoded.includes('/') || decoded.includes('\\')) return false;
    if (hasAsciiControlOrDel(decoded)) return false;
  }
  return true;
}

/**
 * Builds a safe path suffix for `GET ${origin}/v1/${suffix}` after validating each segment.
 * Re-encodes segments so the resulting pathname cannot traverse outside `/v1/...`.
 */
export function buildSafeCfPagesV1ProxyPathSuffix(routeParam: string | string[] | undefined): string | null {
  const joined = Array.isArray(routeParam) ? routeParam.join('/') : (routeParam ?? '');
  if (!isSafeCfPagesV1ProxyPathSuffix(joined)) return null;
  if (joined === '') return '';
  return joined
    .split('/')
    .map((raw) => encodeURIComponent(fullyDecodePathSegment(raw) as string))
    .join('/');
}
