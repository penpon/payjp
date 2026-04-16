/**
 * Builds a safe upstream URL for the Cloudflare Pages `/v1/*` proxy.
 * Rejects path segments that could escape the `/v1/` prefix after URL normalization.
 */

const SAFE_SEGMENT = /^[\w.-]+$/;

export type CfApiProxyTargetOk = { ok: true; url: string };
export type CfApiProxyTargetErr = { ok: false; status: number; body: string };
export type CfApiProxyTargetResult = CfApiProxyTargetOk | CfApiProxyTargetErr;

function normalizeRouteParam(route: string | string[] | undefined): string[] {
  if (route === undefined) {
    return [];
  }
  const raw = Array.isArray(route) ? route.join('/') : route;
  return raw.split('/').filter((s) => s.length > 0);
}

/**
 * @param cfApiOrigin - e.g. `https://api.example.com` (no path)
 * @param route - dynamic path from `[[route]]` (string or string[])
 * @param search - `URL#search` from the incoming request (includes `?` when non-empty)
 */
export function buildCfApiProxyTargetUrl(
  cfApiOrigin: string,
  route: string | string[] | undefined,
  search: string,
): CfApiProxyTargetResult {
  let base: URL;
  try {
    base = new URL(cfApiOrigin.trim());
  } catch {
    return { ok: false, status: 502, body: 'CF_API_ORIGIN is invalid' };
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    return { ok: false, status: 502, body: 'CF_API_ORIGIN is invalid' };
  }
  if (base.username !== '' || base.password !== '') {
    return { ok: false, status: 502, body: 'CF_API_ORIGIN is invalid' };
  }
  if (base.pathname !== '/' || base.search !== '' || base.hash !== '') {
    return { ok: false, status: 502, body: 'CF_API_ORIGIN must be origin-only (no path, query, or fragment)' };
  }

  const segments = normalizeRouteParam(route);
  for (const seg of segments) {
    if (seg === '.' || seg === '..') {
      return { ok: false, status: 400, body: 'Invalid path' };
    }
    if (!SAFE_SEGMENT.test(seg)) {
      return { ok: false, status: 400, body: 'Invalid path' };
    }
  }

  const path = `/v1/${segments.map(encodeURIComponent).join('/')}`;
  const originNoSlash = `${base.origin}`;
  const target = new URL(path + search, `${originNoSlash}/`);

  if (target.origin !== base.origin) {
    return { ok: false, status: 502, body: 'CF_API_ORIGIN is invalid' };
  }
  if (!target.pathname.startsWith('/v1/') && target.pathname !== '/v1') {
    return { ok: false, status: 400, body: 'Invalid path' };
  }

  return { ok: true, url: target.toString() };
}
