import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { escapePgLikePattern, queryMembersList } from '../queries.js';

describe('escapePgLikePattern', () => {
  it('escapes LIKE metacharacters for ILIKE with backslash escape', () => {
    expect(escapePgLikePattern('%')).toBe('\\%');
    expect(escapePgLikePattern('_')).toBe('\\_');
    expect(escapePgLikePattern('\\')).toBe('\\\\');
    expect(escapePgLikePattern('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
  });
});

describe('queryMembersList', () => {
  it('passes an escaped ILIKE pattern so % does not match every row', async () => {
    const mockQuery = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ c: '0' }] })
      .mockResolvedValueOnce({ rows: [] });
    const pool = { query: mockQuery } as unknown as Pool;

    await queryMembersList(pool, {
      page: 1,
      limit: 10,
      q: '%',
      subscriptionStatus: null,
      roleState: null,
      hasInflight: null,
    });

    const countCall = mockQuery.mock.calls[0];
    expect(countCall?.[1]?.[0]).toBe('%\\%%');
    const countSql = countCall?.[0] as string;
    expect(countSql).toContain("m.email ILIKE $1 ESCAPE '\\'");
  });
});
