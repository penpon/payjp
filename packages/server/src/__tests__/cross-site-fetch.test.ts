import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { isForbiddenCrossSiteFetch, parseSecFetchSite } from '../cross-site-fetch.js';

function req(headers: Record<string, string | string[] | undefined>): FastifyRequest {
  return { headers } as FastifyRequest;
}

describe('parseSecFetchSite', () => {
  it('returns absent when header is missing', () => {
    expect(parseSecFetchSite(req({}))).toBe('absent');
  });

  it('returns blank when header is empty or whitespace', () => {
    expect(parseSecFetchSite(req({ 'sec-fetch-site': '' }))).toBe('blank');
    expect(parseSecFetchSite(req({ 'sec-fetch-site': '   ' }))).toBe('blank');
  });

  it('uses first non-empty value when header is an array', () => {
    expect(parseSecFetchSite(req({ 'sec-fetch-site': ['', 'same-origin'] }))).toBe('same-origin');
  });
});

describe('isForbiddenCrossSiteFetch', () => {
  it('allows missing Sec-Fetch-Site (non-browser)', () => {
    expect(isForbiddenCrossSiteFetch(req({}))).toBe(false);
  });

  it('rejects explicit cross-site', () => {
    expect(isForbiddenCrossSiteFetch(req({ 'sec-fetch-site': 'cross-site' }))).toBe(true);
  });

  it('rejects blank Sec-Fetch-Site (cannot classify as same-origin navigation)', () => {
    expect(isForbiddenCrossSiteFetch(req({ 'sec-fetch-site': '' }))).toBe(true);
    expect(isForbiddenCrossSiteFetch(req({ 'sec-fetch-site': '   ' }))).toBe(true);
  });

  it('allows same-origin', () => {
    expect(isForbiddenCrossSiteFetch(req({ 'sec-fetch-site': 'same-origin' }))).toBe(false);
  });

  it('allows same-site', () => {
    expect(isForbiddenCrossSiteFetch(req({ 'sec-fetch-site': 'same-site' }))).toBe(false);
  });

  it('rejects Sec-Fetch-Site: none (top-level navigation, not same-origin)', () => {
    expect(isForbiddenCrossSiteFetch(req({ 'sec-fetch-site': 'none' }))).toBe(true);
  });
});
