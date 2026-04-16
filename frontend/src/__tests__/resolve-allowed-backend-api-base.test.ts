import { describe, expect, it } from 'vitest';
import { resolveAllowedBackendApiBase } from '../resolve-allowed-backend-api-base.js';

describe('resolveAllowedBackendApiBase', () => {
  it('accepts https bare origins', () => {
    expect(resolveAllowedBackendApiBase('https://api.example.com')).toEqual({
      ok: true,
      baseUrl: 'https://api.example.com',
    });
    expect(resolveAllowedBackendApiBase('  https://api.example.com  ')).toEqual({
      ok: true,
      baseUrl: 'https://api.example.com',
    });
  });

  it('accepts https with explicit port', () => {
    expect(resolveAllowedBackendApiBase('https://api.example.com:8443')).toEqual({
      ok: true,
      baseUrl: 'https://api.example.com:8443',
    });
  });

  it('rejects empty', () => {
    expect(resolveAllowedBackendApiBase(undefined).ok).toBe(false);
    expect(resolveAllowedBackendApiBase('').ok).toBe(false);
    expect(resolveAllowedBackendApiBase('   ').ok).toBe(false);
  });

  it('rejects non-https', () => {
    expect(resolveAllowedBackendApiBase('http://api.example.com').ok).toBe(false);
  });

  it('rejects userinfo (credential prefix)', () => {
    expect(resolveAllowedBackendApiBase('https://user:pass@api.example.com').ok).toBe(false);
  });

  it('rejects path, query, or fragment', () => {
    expect(resolveAllowedBackendApiBase('https://api.example.com/v1').ok).toBe(false);
    expect(resolveAllowedBackendApiBase('https://api.example.com?x=1').ok).toBe(false);
    expect(resolveAllowedBackendApiBase('https://api.example.com#frag').ok).toBe(false);
  });

  it('rejects non-URL garbage', () => {
    expect(resolveAllowedBackendApiBase('not a url').ok).toBe(false);
  });
});
