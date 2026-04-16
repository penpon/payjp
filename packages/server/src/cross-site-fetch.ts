import type { FastifyRequest } from 'fastify';

/** Reject cross-site browser requests that omit Origin (e.g. form posts). curl omits Sec-Fetch-Site. */
export function isForbiddenCrossSiteFetch(request: FastifyRequest): boolean {
  const secFetchSite = typeof request.headers['sec-fetch-site'] === 'string' ? request.headers['sec-fetch-site'] : '';
  return secFetchSite === 'cross-site';
}
