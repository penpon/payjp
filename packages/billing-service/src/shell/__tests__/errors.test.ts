import { describe, expect, it } from 'vitest';
import { isUncertainError } from '../errors.js';

describe('isUncertainError', () => {
  it('treats TypeError as uncertain (fetch may throw TypeError for network failures)', () => {
    expect(isUncertainError(new TypeError('fetch failed'))).toBe(true);
  });

  it('treats generic TypeError (no network message) as uncertain — safe side for fetch/undici', () => {
    expect(isUncertainError(new TypeError('Cannot read properties of undefined'))).toBe(true);
  });

  it('treats RangeError as definite (non-uncertain)', () => {
    expect(isUncertainError(new RangeError('out of range'))).toBe(false);
  });

  it('treats SyntaxError as definite (non-uncertain)', () => {
    expect(isUncertainError(new SyntaxError('bad syntax'))).toBe(false);
  });

  it('treats ENOTFOUND errno as uncertain', () => {
    const err = new Error('getaddrinfo ENOTFOUND');
    (err as NodeJS.ErrnoException).code = 'ENOTFOUND';
    expect(isUncertainError(err)).toBe(true);
  });

  it('treats ECONNREFUSED errno as uncertain', () => {
    const err = new Error('connect');
    (err as NodeJS.ErrnoException).code = 'ECONNREFUSED';
    expect(isUncertainError(err)).toBe(true);
  });
});
