import { describe, expect, it } from 'vitest';
import { buildCfApiProxyTargetUrl } from './cf-api-proxy-target.js';

describe('buildCfApiProxyTargetUrl', () => {
  it('joins origin, /v1/, route segments, and query string', () => {
    expect(
      buildCfApiProxyTargetUrl({
        apiOrigin: 'https://api.example.com',
        route: ['members', 'me'],
        search: '?x=1',
      }),
    ).toBe('https://api.example.com/v1/members/me?x=1');
  });

  it('returns null when a segment is .. (path escape)', () => {
    expect(
      buildCfApiProxyTargetUrl({
        apiOrigin: 'https://api.example.com',
        route: ['..', 'health'],
        search: '',
      }),
    ).toBeNull();
  });

  it('returns null when a segment is percent-encoded ..', () => {
    expect(
      buildCfApiProxyTargetUrl({
        apiOrigin: 'https://api.example.com',
        route: ['%2e%2e', 'health'],
        search: '',
      }),
    ).toBeNull();
  });

  it('returns null when a segment is .', () => {
    expect(
      buildCfApiProxyTargetUrl({
        apiOrigin: 'https://api.example.com',
        route: ['.', 'x'],
        search: '',
      }),
    ).toBeNull();
  });

  it('allows empty route (GET /v1/)', () => {
    expect(
      buildCfApiProxyTargetUrl({
        apiOrigin: 'https://api.example.com/',
        route: undefined,
        search: '',
      }),
    ).toBe('https://api.example.com/v1/');
  });
});
