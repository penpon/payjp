/**
 * Build the backend URL for the Pages `/v1/*` proxy.
 * Rejects path traversal (`..`, encoded slashes) so the proxy cannot be used
 * to reach non-`/v1/` paths on CF_API_ORIGIN.
 */
export type V1ProxyTargetResult = { ok: true; url: string } | { ok: false; reason: string };

export function buildV1ProxyTargetUrl(
  cfApiOrigin: string,
  routeParam: string | string[] | undefined,
  search: string,
): V1ProxyTargetResult {
  const raw = Array.isArray(routeParam) ? routeParam.join('/') : (routeParam ?? '');
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return { ok: false, reason: 'invalid_encoding' };
  }
  if (decoded.length === 0) {
    return { ok: false, reason: 'empty_route' };
  }
  for (let i = 0; i < decoded.length; i++) {
    const c = decoded.charCodeAt(i);
    if (c < 32 || c === 127) {
      return { ok: false, reason: 'control_chars' };
    }
  }
  const segments = decoded.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      return { ok: false, reason: 'invalid_segment' };
    }
    if (/[?#]/.test(seg)) {
      return { ok: false, reason: 'invalid_segment' };
    }
  }

  let base: URL;
  try {
    const origin = cfApiOrigin.replace(/\/$/, '');
    base = new URL(`${origin}/`);
  } catch {
    return { ok: false, reason: 'bad_origin' };
  }

  const target = new URL(`/v1/${decoded}`, base);
  if (target.origin !== base.origin) {
    return { ok: false, reason: 'wrong_origin' };
  }
  if (!target.pathname.startsWith('/v1/') || target.pathname === '/v1') {
    return { ok: false, reason: 'path_escape' };
  }

  target.search = search;
  return { ok: true, url: target.href };
}
