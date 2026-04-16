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

import { prepareV1ProxyTarget } from './v1-proxy.js';

interface Env {
  CF_API_ORIGIN: string;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env, params } = context;

  if (!env.CF_API_ORIGIN) {
    return new Response('CF_API_ORIGIN is not configured', { status: 502 });
  }

  const rawRoute = params.route;
  const routeSegments = Array.isArray(rawRoute) ? rawRoute : rawRoute != null && rawRoute !== '' ? [rawRoute] : [];

  const incomingUrl = new URL(request.url);
  const prepared = prepareV1ProxyTarget(env.CF_API_ORIGIN, routeSegments, incomingUrl.search);
  if (!prepared.ok) {
    return new Response(prepared.body, { status: prepared.status });
  }

  const proxyRequest = new Request(prepared.targetUrl, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: 'manual',
  });

  return fetch(proxyRequest);
};
