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

import { buildV1ProxyTargetUrl } from '../_lib/v1-proxy-target-url';

interface Env {
  CF_API_ORIGIN: string;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env, params } = context;

  if (!env.CF_API_ORIGIN) {
    return new Response('CF_API_ORIGIN is not configured', { status: 502 });
  }

  const incomingUrl = new URL(request.url);
  const built = buildV1ProxyTargetUrl(env.CF_API_ORIGIN, params.route, incomingUrl.search);
  if (!built.ok) {
    return new Response('Bad Request', { status: 400 });
  }
  const targetUrl = built.url;

  const proxyRequest = new Request(targetUrl, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: 'manual',
  });

  return fetch(proxyRequest);
};
