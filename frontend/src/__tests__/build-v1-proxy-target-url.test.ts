import { describe, expect, it } from 'vitest';
import { buildV1ProxyTargetUrl } from '../../functions/build-v1-proxy-target-url.js';

describe('buildV1ProxyTargetUrl', () => {
  it('builds /v1/... under a clean https origin', () => {
    const r = buildV1ProxyTargetUrl('https://api.example.com', ['subscriptions', 'status'], '?x=1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.url.toString()).toBe('https://api.example.com/v1/subscriptions/status?x=1');
    }
  });

  it('rejects origin with embedded userinfo (request smuggling)', () => {
    const r = buildV1ProxyTargetUrl('https://evil.com\\@api.example.com', [], '');
    expect(r.ok).toBe(false);
  });

  it('rejects path traversal in route segments', () => {
    expect(buildV1ProxyTargetUrl('https://api.example.com', ['..', 'foo'], '').ok).toBe(false);
    expect(buildV1ProxyTargetUrl('https://api.example.com', ['%2e%2e'], '').ok).toBe(false);
  });

  it('allows empty route (GET /v1/)', () => {
    const r = buildV1ProxyTargetUrl('https://api.example.com', undefined, '');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url.pathname).toBe('/v1/');
  });

  it('allows http only for loopback', () => {
    const okLocal = buildV1ProxyTargetUrl('http://127.0.0.1:3000', ['a'], '');
    expect(okLocal.ok).toBe(true);
    const bad = buildV1ProxyTargetUrl('http://example.com', [], '');
    expect(bad.ok).toBe(false);
  });
});
