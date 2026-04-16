/**
 * Shared helpers for the Cloudflare Pages /v1/* reverse proxy.
 * Keeps path construction and validation testable outside the Worker runtime.
 */

const MAX_SEGMENT_LENGTH = 256;
const MAX_SEGMENT_COUNT = 32;

/** Reject traversal, smuggling, and other unexpected segment content. */
export function isValidV1ProxyRouteSegment(segment: string): boolean {
  if (segment.length === 0 || segment.length > MAX_SEGMENT_LENGTH) return false;
  if (segment === '.' || segment === '..') return false;
  // Encoded dots/slashes or other smuggling — deny; only literal safe segments allowed
  if (segment.includes('%')) return false;
  for (let i = 0; i < segment.length; i++) {
    const c = segment.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return false;
    const ch = segment[i]!;
    if (ch === '/' || ch === '?' || ch === '#') return false;
  }
  return true;
}

export function parseCfApiOrigin(raw: string): URL | null {
  const trimmed = raw.trim().replace(/\/$/, '');
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.username !== '' || u.password !== '') return null;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  const pathNoSlash = u.pathname.replace(/\/$/, '') || '';
  if (pathNoSlash !== '') return null;
  return u;
}

export type V1ProxyPrepareResult = { ok: true; targetUrl: URL } | { ok: false; status: number; body: string };

/**
 * Build the upstream URL for GET/POST /v1/... on the Pages host.
 * `routeSegments` comes from the catch-all param (already URL-decoded by the runtime).
 */
export function prepareV1ProxyTarget(
  cfApiOriginRaw: string,
  routeSegments: string[],
  search: string,
): V1ProxyPrepareResult {
  const base = parseCfApiOrigin(cfApiOriginRaw);
  if (!base) {
    return { ok: false, status: 502, body: 'Invalid CF_API_ORIGIN' };
  }

  if (routeSegments.length === 0 || routeSegments.length > MAX_SEGMENT_COUNT) {
    return { ok: false, status: 400, body: 'Bad Request' };
  }
  for (const seg of routeSegments) {
    if (!isValidV1ProxyRouteSegment(seg)) {
      return { ok: false, status: 400, body: 'Bad Request' };
    }
  }

  const path = `/v1/${routeSegments.map((s) => encodeURIComponent(s)).join('/')}`;
  let targetUrl: URL;
  try {
    targetUrl = new URL(path + search, base.origin);
  } catch {
    return { ok: false, status: 400, body: 'Bad Request' };
  }

  if (targetUrl.origin !== base.origin) {
    return { ok: false, status: 502, body: 'Invalid proxy target' };
  }

  return { ok: true, targetUrl };
}
