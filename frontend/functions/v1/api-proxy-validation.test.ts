import { describe, expect, it } from 'vitest';
import { assertSafeProxyRouteSegments, parseApiOrigin } from './api-proxy-validation.js';

describe('parseApiOrigin', () => {
  it('accepts bare https origin', () => {
    expect(parseApiOrigin('https://api.example.com')).toEqual({
      ok: true,
      origin: 'https://api.example.com',
    });
  });

  it('strips trailing slash', () => {
    expect(parseApiOrigin('https://api.example.com/')).toEqual({
      ok: true,
      origin: 'https://api.example.com',
    });
  });

  it('rejects missing', () => {
    expect(parseApiOrigin(undefined)).toEqual({ ok: false, reason: 'missing' });
    expect(parseApiOrigin('   ')).toEqual({ ok: false, reason: 'missing' });
  });

  it('rejects userinfo (open proxy / credential injection)', () => {
    expect(parseApiOrigin('https://user:pass@api.example.com')).toEqual({ ok: false, reason: 'invalid_origin' });
  });

  it('rejects path beyond origin', () => {
    expect(parseApiOrigin('https://api.example.com/v1')).toEqual({ ok: false, reason: 'invalid_origin' });
  });

  it('rejects query and hash', () => {
    expect(parseApiOrigin('https://api.example.com?x=1')).toEqual({ ok: false, reason: 'invalid_origin' });
    expect(parseApiOrigin('https://api.example.com#frag')).toEqual({ ok: false, reason: 'invalid_origin' });
  });
});

describe('assertSafeProxyRouteSegments', () => {
  it('accepts normal API subpaths', () => {
    expect(assertSafeProxyRouteSegments(['auth', 'discord', 'callback'])).toEqual({ ok: true });
  });

  it('rejects dot segments', () => {
    expect(assertSafeProxyRouteSegments(['..'])).toMatchObject({ ok: false, reason: 'path_traversal' });
    expect(assertSafeProxyRouteSegments(['.'])).toMatchObject({ ok: false, reason: 'path_traversal' });
  });

  it('rejects encoded traversal', () => {
    expect(assertSafeProxyRouteSegments(['%2e%2e'])).toMatchObject({ ok: false, reason: 'path_traversal' });
    expect(assertSafeProxyRouteSegments(['%2e'])).toMatchObject({ ok: false, reason: 'path_traversal' });
  });

  it('rejects double-encoded traversal', () => {
    expect(assertSafeProxyRouteSegments(['%252e%252e'])).toMatchObject({ ok: false, reason: 'path_traversal' });
  });

  it('rejects empty segment (double slash)', () => {
    expect(assertSafeProxyRouteSegments(['foo', '', 'bar'])).toMatchObject({ ok: false, reason: 'empty_segment' });
  });
});
