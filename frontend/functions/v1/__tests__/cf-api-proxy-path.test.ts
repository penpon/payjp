import { describe, expect, it } from 'vitest';
import { isUnsafeV1ApiProxyRoute } from '../cf-api-proxy-path.js';

describe('isUnsafeV1ApiProxyRoute', () => {
  it('allows normal API subpaths', () => {
    expect(isUnsafeV1ApiProxyRoute('members/me')).toBe(false);
    expect(isUnsafeV1ApiProxyRoute('subscriptions')).toBe(false);
  });

  it('rejects empty and dot segments', () => {
    expect(isUnsafeV1ApiProxyRoute('')).toBe(true);
    expect(isUnsafeV1ApiProxyRoute('foo//bar')).toBe(true);
    expect(isUnsafeV1ApiProxyRoute('../health')).toBe(true);
    expect(isUnsafeV1ApiProxyRoute('a/./b')).toBe(true);
  });

  it('rejects encoded parent directory segments', () => {
    expect(isUnsafeV1ApiProxyRoute('%2e%2e/health')).toBe(true);
    expect(isUnsafeV1ApiProxyRoute('%2e./health')).toBe(true);
    expect(isUnsafeV1ApiProxyRoute('.%2e/health')).toBe(true);
  });

  it('rejects slash or backslash inside a segment', () => {
    expect(isUnsafeV1ApiProxyRoute('foo%2fbar')).toBe(true);
    expect(isUnsafeV1ApiProxyRoute('foo%2f..')).toBe(true);
    expect(isUnsafeV1ApiProxyRoute('x\\y')).toBe(true);
  });

  it('rejects malformed percent-encoding', () => {
    expect(isUnsafeV1ApiProxyRoute('%')).toBe(true);
    expect(isUnsafeV1ApiProxyRoute('%zz')).toBe(true);
  });
});
