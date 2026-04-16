import { describe, expect, it } from 'vitest';
import { buildCfApiProxyTargetUrl } from './cf-pages-proxy-target.js';

describe('buildCfApiProxyTargetUrl', () => {
  const origin = 'https://api.example.com';

  it('builds /v1/... under the configured origin', () => {
    const r = buildCfApiProxyTargetUrl(origin, 'auth/discord/start', '');
    expect(r.ok && r.url).toBeTruthy();
    if (r.ok) {
      expect(r.url).toBe('https://api.example.com/v1/auth/discord/start');
    }
  });

  it('preserves query string', () => {
    const r = buildCfApiProxyTargetUrl(origin, 'foo', '?a=1');
    expect(r.ok && r.url).toBeTruthy();
    if (r.ok) {
      expect(r.url).toBe('https://api.example.com/v1/foo?a=1');
    }
  });

  it('rejects .. segments that would escape /v1/', () => {
    const r = buildCfApiProxyTargetUrl(origin, ['..', 'internal'], '');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
    }
  });

  it('rejects . segment', () => {
    const r = buildCfApiProxyTargetUrl(origin, ['.', 'x'], '');
    expect(r.ok).toBe(false);
  });

  it('collapses empty segments from double slashes (still under /v1/)', () => {
    const r = buildCfApiProxyTargetUrl(origin, ['foo', '', 'bar'], '');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.url).toBe('https://api.example.com/v1/foo/bar');
    }
  });

  it('rejects userinfo in CF_API_ORIGIN', () => {
    const r = buildCfApiProxyTargetUrl('https://user:pass@evil.com', 'x', '');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(502);
    }
  });

  it('rejects CF_API_ORIGIN with path', () => {
    const r = buildCfApiProxyTargetUrl('https://api.example.com/other', 'x', '');
    expect(r.ok).toBe(false);
  });
});
