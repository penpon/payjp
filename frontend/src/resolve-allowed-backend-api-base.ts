/**
 * Validates `CF_API_ORIGIN` for the Cloudflare Pages API proxy (frontend/functions).
 * Rejects schemes other than https, userinfo, paths, query, and fragment so the
 * proxy cannot be pointed at arbitrary URLs (SSRF-style misconfiguration).
 */
export type ResolveAllowedBackendApiBaseResult = { ok: true; baseUrl: string } | { ok: false; reason: string };

export function resolveAllowedBackendApiBase(raw: string | undefined): ResolveAllowedBackendApiBaseResult {
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '') {
    return { ok: false, reason: 'empty' };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }

  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'https_required' };
  }

  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'userinfo_not_allowed' };
  }

  if (!url.hostname || url.hostname.length === 0) {
    return { ok: false, reason: 'host_required' };
  }

  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    return { ok: false, reason: 'must_be_bare_origin' };
  }

  return { ok: true, baseUrl: `${url.origin}` };
}
