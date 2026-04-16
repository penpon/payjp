/**
 * Build a safe upstream URL for the Cloudflare Pages `/v1/*` proxy.
 * Rejects smuggling (userinfo in origin), path tricks, and non-HTTPS origins (except loopback http for local dev).
 */

const LOCAL_HTTP_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export type BuildV1ProxyTargetResult = { ok: true; url: URL } | { ok: false; status: number; body: string };

function isSafePathSegment(segment: string): boolean {
  if (segment === '') return false;
  if (segment.includes('/') || segment.includes('\\')) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return false;
  }
  if (decoded === '' || decoded === '.' || decoded === '..') return false;
  if (decoded.includes('..')) return false;
  return true;
}

function normalizeRouteParam(route: string | string[] | undefined): string[] | null {
  if (route === undefined) return [];
  const parts = Array.isArray(route) ? route : [route];
  const out: string[] = [];
  for (const p of parts) {
    if (typeof p !== 'string' || !isSafePathSegment(p)) return null;
    out.push(decodeURIComponent(p));
  }
  return out;
}

export function buildV1ProxyTargetUrl(
  apiOriginRaw: string,
  routeParam: string | string[] | undefined,
  search: string,
): BuildV1ProxyTargetResult {
  let trimmed = apiOriginRaw.trim();
  if (!trimmed) {
    return { ok: false, status: 502, body: 'CF_API_ORIGIN is not configured' };
  }
  trimmed = trimmed.replace(/\/$/, '');

  let originUrl: URL;
  try {
    originUrl = new URL(trimmed);
  } catch {
    return { ok: false, status: 502, body: 'CF_API_ORIGIN is not a valid URL' };
  }

  if (originUrl.username !== '' || originUrl.password !== '') {
    return { ok: false, status: 502, body: 'CF_API_ORIGIN must not include credentials' };
  }

  const proto = originUrl.protocol;
  const host = originUrl.hostname;
  if (proto === 'https:') {
    // ok
  } else if (proto === 'http:' && LOCAL_HTTP_HOSTS.has(host)) {
    // ok — local Pages dev only
  } else {
    return { ok: false, status: 502, body: 'CF_API_ORIGIN must use https' };
  }

  if (originUrl.pathname !== '/' && originUrl.pathname !== '') {
    return { ok: false, status: 502, body: 'CF_API_ORIGIN must be origin-only (no path)' };
  }

  const segments = normalizeRouteParam(routeParam);
  if (segments === null) {
    return { ok: false, status: 400, body: 'Invalid path' };
  }

  const path = `/v1/${segments.map((s) => encodeURIComponent(s)).join('/')}`;
  let target: URL;
  try {
    target = new URL(path + search, originUrl);
  } catch {
    return { ok: false, status: 502, body: 'Failed to build proxy URL' };
  }

  if (target.origin !== originUrl.origin) {
    return { ok: false, status: 502, body: 'Invalid proxy target' };
  }

  return { ok: true, url: target };
}
