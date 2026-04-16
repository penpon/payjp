/**
 * RFC 6454 origin comparison with explicit edge-case guards used by API routes.
 * - Rejects `null` and empty origins
 * - Rejects trailing slash in request origin
 * - Compares scheme + host(case-insensitive) + normalized port
 */
export function isSameOrigin(requestOrigin: string, allowedOrigin: string): boolean {
  if (requestOrigin === 'null' || requestOrigin === '') return false;
  if (requestOrigin.endsWith('/')) return false;
  try {
    const req = new URL(requestOrigin);
    const allowed = new URL(allowedOrigin);
    if (req.protocol !== allowed.protocol) return false;
    if (req.hostname.toLowerCase() !== allowed.hostname.toLowerCase()) return false;
    const normalizePort = (url: URL): string => {
      if (url.port !== '') return url.port;
      if (url.protocol === 'https:') return '443';
      if (url.protocol === 'http:') return '80';
      return '';
    };
    return normalizePort(req) === normalizePort(allowed);
  } catch {
    return false;
  }
}
