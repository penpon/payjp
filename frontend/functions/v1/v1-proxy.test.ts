import { describe, expect, it } from 'vitest';
import { isValidV1ProxyRouteSegment, parseCfApiOrigin, prepareV1ProxyTarget } from './v1-proxy.js';

describe('isValidV1ProxyRouteSegment', () => {
  it('allows typical API segments', () => {
    expect(isValidV1ProxyRouteSegment('subscriptions')).toBe(true);
    expect(isValidV1ProxyRouteSegment('payjp')).toBe(true);
  });

  it('rejects traversal and empty', () => {
    expect(isValidV1ProxyRouteSegment('')).toBe(false);
    expect(isValidV1ProxyRouteSegment('.')).toBe(false);
    expect(isValidV1ProxyRouteSegment('..')).toBe(false);
  });

  it('rejects percent-encoded smuggling attempts', () => {
    expect(isValidV1ProxyRouteSegment('%2e%2e')).toBe(false);
    expect(isValidV1ProxyRouteSegment('x%2fy')).toBe(false);
  });
});

describe('parseCfApiOrigin', () => {
  it('accepts bare https origins', () => {
    const u = parseCfApiOrigin('https://api.example.com');
    expect(u?.origin).toBe('https://api.example.com');
  });

  it('rejects userinfo and paths', () => {
    expect(parseCfApiOrigin('https://user:pass@api.example.com')).toBeNull();
    expect(parseCfApiOrigin('https://api.example.com/foo')).toBeNull();
  });
});

describe('prepareV1ProxyTarget', () => {
  it('builds /v1/... under the configured origin', () => {
    const r = prepareV1ProxyTarget('https://api.example.com', ['subscriptions', 'status'], '?x=1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.targetUrl.href).toBe('https://api.example.com/v1/subscriptions/status?x=1');
    }
  });

  it('returns 400 for empty or invalid segments', () => {
    expect(prepareV1ProxyTarget('https://api.example.com', [], '')).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(prepareV1ProxyTarget('https://api.example.com', ['..'], '')).toMatchObject({
      ok: false,
      status: 400,
    });
  });
});
