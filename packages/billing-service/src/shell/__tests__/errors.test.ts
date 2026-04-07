import { describe, expect, it } from 'vitest';
import { isUncertainError } from '../errors.js';

describe('isUncertainError', () => {
  it('treats TypeError as uncertain (fetch may throw TypeError for network failures)', () => {
    expect(isUncertainError(new TypeError('fetch failed'))).toBe(true);
  });

  it('treats TypeError with undici-style message as uncertain', () => {
    expect(isUncertainError(new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND') }))).toBe(true);
  });

  it('treats RangeError as definite (non-uncertain)', () => {
    expect(isUncertainError(new RangeError('out of range'))).toBe(false);
  });

  it('treats SyntaxError as definite (non-uncertain)', () => {
    expect(isUncertainError(new SyntaxError('bad syntax'))).toBe(false);
  });

  it('treats errno on Error as uncertain', () => {
    const err = new Error('connect');
    (err as NodeJS.ErrnoException).code = 'ECONNREFUSED';
    expect(isUncertainError(err)).toBe(true);
  });
});
