import { describe, expect, it } from 'vitest';
import { buildSafeCfPagesV1ProxyPathSuffix, isSafeCfPagesV1ProxyPathSuffix } from '../cf-pages-proxy-route.js';

describe('isSafeCfPagesV1ProxyPathSuffix', () => {
  it('allows empty and normal segments', () => {
    expect(isSafeCfPagesV1ProxyPathSuffix('')).toBe(true);
    expect(isSafeCfPagesV1ProxyPathSuffix('subscriptions/status')).toBe(true);
  });

  it('rejects traversal and dot segments', () => {
    expect(isSafeCfPagesV1ProxyPathSuffix('..')).toBe(false);
    expect(isSafeCfPagesV1ProxyPathSuffix('foo/..')).toBe(false);
    expect(isSafeCfPagesV1ProxyPathSuffix('foo/../bar')).toBe(false);
    expect(isSafeCfPagesV1ProxyPathSuffix('.')).toBe(false);
  });

  it('rejects encoded traversal after full decode', () => {
    expect(isSafeCfPagesV1ProxyPathSuffix('%2e%2e')).toBe(false);
    expect(isSafeCfPagesV1ProxyPathSuffix('%252e%252e')).toBe(false);
    expect(isSafeCfPagesV1ProxyPathSuffix('foo/%2e%2e')).toBe(false);
  });

  it('rejects empty segment (double slash)', () => {
    expect(isSafeCfPagesV1ProxyPathSuffix('foo//bar')).toBe(false);
  });

  it('rejects backslash in decoded segment', () => {
    expect(isSafeCfPagesV1ProxyPathSuffix('%5c')).toBe(false);
  });
});

describe('buildSafeCfPagesV1ProxyPathSuffix', () => {
  it('returns encoded safe path', () => {
    expect(buildSafeCfPagesV1ProxyPathSuffix('subscriptions/status')).toBe('subscriptions/status');
    expect(buildSafeCfPagesV1ProxyPathSuffix(['a', 'b'])).toBe('a/b');
  });

  it('returns null for unsafe input', () => {
    expect(buildSafeCfPagesV1ProxyPathSuffix('..')).toBe(null);
    expect(buildSafeCfPagesV1ProxyPathSuffix('%2e%2e')).toBe(null);
  });
});
