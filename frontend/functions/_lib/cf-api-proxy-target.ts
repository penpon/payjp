/**
 * Builds the upstream URL for the Cloudflare Pages `/v1/*` API proxy.
 * Rejects `..` / `.` path segments so callers cannot escape the `/v1/` prefix.
 */
function isUnsafePathSegment(seg: string): boolean {
  if (seg === '' || seg === '.' || seg === '..') return true;
  let decoded: string;
  try {
    decoded = decodeURIComponent(seg);
  } catch {
    return true;
  }
  return decoded === '.' || decoded === '..';
}

export function buildCfApiProxyTargetUrl(params: {
  apiOrigin: string;
  route: string | string[] | undefined;
  search: string;
}): string | null {
  const { apiOrigin, route, search } = params;
  const origin = apiOrigin.replace(/\/$/, '');
  const segments = Array.isArray(route) ? route : route !== undefined && route !== '' ? [route] : [];
  for (const seg of segments) {
    if (isUnsafePathSegment(seg)) {
      return null;
    }
  }
  const pathSuffix = segments.join('/');
  return `${origin}/v1/${pathSuffix}${search}`;
}
