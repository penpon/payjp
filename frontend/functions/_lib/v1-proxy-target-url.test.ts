import { describe, expect, it } from 'vitest';
import { buildV1ProxyTargetUrl } from './v1-proxy-target-url';

describe('buildV1ProxyTargetUrl', () => {
  const origin = 'https://api.example.com';

  it('builds /v1/... under the API origin', () => {
    const r = buildV1ProxyTargetUrl(origin, 'subscriptions/status', '?x=1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.url).toBe('https://api.example.com/v1/subscriptions/status?x=1');
  });

  it('rejects .. segments (blocks ../ path escape against backend origin)', () => {
    const r = buildV1ProxyTargetUrl(origin, '..%2fhealth', '');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('invalid_segment');
  });

  it('allows multi-segment paths under /v1 (encoded slash)', () => {
    const r = buildV1ProxyTargetUrl(origin, 'a%2fb', '');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.url).toBe('https://api.example.com/v1/a/b');
  });

  it('rejects empty segments', () => {
    expect(buildV1ProxyTargetUrl(origin, 'a//b', '').ok).toBe(false);
  });

  it('rejects dot segments', () => {
    expect(buildV1ProxyTargetUrl(origin, '.', '').ok).toBe(false);
    expect(buildV1ProxyTargetUrl(origin, 'a/./b', '').ok).toBe(false);
  });
});
