/**
 * Cloudflare Pages Function: API proxy
 *
 * Rewrites /v1/* → CF_API_ORIGIN/v1/* on the server side so that the browser
 * sees all traffic as same-origin. This is required for __Host- cookies:
 * they carry no Domain attribute and are bound to the host that set them,
 * so the backend must respond through the same host as the frontend.
 *
 * Environment variable (set in Cloudflare Pages dashboard):
 *   CF_API_ORIGIN  e.g. https://api.example.com  (no trailing slash)
 */

import { assertSafeProxyRouteSegments, parseApiOrigin } from './api-proxy-validation.js';

interface Env {
  CF_API_ORIGIN: string;
}

/**
 * Parse `CF_API_ORIGIN` as a bare https origin (scheme + host[:port] only).
 * Rejects path/query/fragment/credentials so a typo cannot turn this function into a generic open proxy.
 */
function parseStrictHttpsOrigin(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (u.username !== '' || u.password !== '') return null;
  if (u.pathname !== '/' && u.pathname !== '') return null;
  if (u.search !== '' || u.hash !== '') return null;
  if (!u.hostname) return null;
  return u.origin;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env, params } = context;

  const parsed = parseApiOrigin(env.CF_API_ORIGIN);
  if (!parsed.ok) {
    const body = parsed.reason === 'missing' ? 'CF_API_ORIGIN is not configured' : 'CF_API_ORIGIN is invalid';
    return new Response(body, { status: 502 });
  }

  const routeParts = Array.isArray(params.route) ? params.route : params.route ? [params.route] : [];
  const safe = assertSafeProxyRouteSegments(routeParts);
  if (!safe.ok) {
    return new Response('Bad Request', { status: 400 });
  }

  const route = routeParts.join('/');
  const incomingUrl = new URL(request.url);
  const targetUrl = `${parsed.origin}/v1/${route}${incomingUrl.search}`;

  const proxyRequest = new Request(targetUrl, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: 'manual',
  });

  return fetch(proxyRequest);
};
