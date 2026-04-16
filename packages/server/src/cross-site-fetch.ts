import type { FastifyRequest } from 'fastify';

/**
 * Normalize `Sec-Fetch-Site` for CSRF-style checks.
 * - Missing header → browser did not send it (curl, server-side) → treat as allowed.
 * - Present but empty/whitespace → treat as cross-site risk (forged/edge request).
 * - Array (duplicate headers) → use the first non-empty value, else blank.
 */
export function parseSecFetchSite(request: FastifyRequest): 'absent' | 'blank' | string {
  const raw = request.headers['sec-fetch-site'];
  if (raw === undefined) {
    return 'absent';
  }
  const first = Array.isArray(raw) ? raw.find((s) => typeof s === 'string' && s.trim() !== '') : raw;
  if (typeof first !== 'string') {
    return 'blank';
  }
  const trimmed = first.trim();
  if (trimmed === '') {
    return 'blank';
  }
  return trimmed.toLowerCase();
}

/**
 * Reject cross-site browser requests. curl and other non-browser callers omit `Sec-Fetch-Site` → allowed.
 * Empty/invalid `Sec-Fetch-Site` is rejected so attackers cannot bypass by sending `Sec-Fetch-Site:` with a matching Origin.
 */
export function isForbiddenCrossSiteFetch(request: FastifyRequest): boolean {
  const site = parseSecFetchSite(request);
  if (site === 'absent') {
    return false;
  }
  if (site === 'blank') {
    return true;
  }
  return site === 'cross-site';
}
