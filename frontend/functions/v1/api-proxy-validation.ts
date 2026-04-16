/**
 * Hardening for Cloudflare Pages `/v1/*` proxy — reject path traversal and
 * unsafe API origins before forwarding to CF_API_ORIGIN.
 */

export type ApiOriginParseResult =
  | { ok: true; origin: string }
  | { ok: false; reason: 'missing' | 'invalid_url' | 'invalid_origin' };

/**
 * Parse CF_API_ORIGIN: must be http(s) with host only (no userinfo, path, query, or hash).
 */
export function parseApiOrigin(raw: string | undefined): ApiOriginParseResult {
  if (raw === undefined || raw.trim() === '') {
    return { ok: false, reason: 'missing' };
  }
  const trimmed = raw.trim().replace(/\/$/, '');
  let url: URL;
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'invalid_origin' };
  }
  if (!url.hostname || url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'invalid_origin' };
  }
  if (url.pathname !== '' && url.pathname !== '/') {
    return { ok: false, reason: 'invalid_origin' };
  }
  if (url.search !== '' || url.hash !== '') {
    return { ok: false, reason: 'invalid_origin' };
  }

  return { ok: true, origin: `${url.protocol}//${url.host}` };
}

/**
 * Fully decode a path segment (handles double-encoding) and reject `.` / `..`.
 */
export function assertSafeProxyRouteSegments(routeParts: string[]): { ok: true } | { ok: false; reason: string } {
  for (const raw of routeParts) {
    if (raw === '') {
      return { ok: false, reason: 'empty_segment' };
    }
    let segment = raw;
    let prev = '';
    for (let i = 0; i < 10 && segment !== prev; i++) {
      prev = segment;
      try {
        segment = decodeURIComponent(segment);
      } catch {
        return { ok: false, reason: 'bad_percent_encoding' };
      }
    }
    if (segment.includes('\0')) {
      return { ok: false, reason: 'null_byte' };
    }
    // Reject slashes inside a segment (e.g. foo%2f..) — same boundary as cf-api-proxy-path.ts
    if (segment.includes('/') || segment.includes('\\')) {
      return { ok: false, reason: 'path_traversal' };
    }
    if (segment === '.' || segment === '..') {
      return { ok: false, reason: 'path_traversal' };
    }
  }
  return { ok: true };
}
