/**
 * Validates path segments for the Cloudflare Pages → API origin proxy.
 * Rejects traversal (`..`), encoded dots, slashes inside segments, and empty segments.
 */
export function isUnsafeV1ApiProxyRoute(route: string): boolean {
  if (route === '') {
    return true;
  }
  const segments = route.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      return true;
    }
    const lower = seg.toLowerCase();
    if (lower === '%2e%2e' || lower === '%2e.' || lower === '.%2e') {
      return true;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      return true;
    }
    if (decoded.includes('/') || decoded.includes('\\')) {
      return true;
    }
    if (decoded === '..') {
      return true;
    }
  }
  return false;
}
