/**
 * E2E: shared passcode → verify sets __Host-access_gate → subscribe succeeds.
 * Requires PostgreSQL (DATABASE_URL_TEST or DATABASE_URL).
 */
import { randomUUID } from 'node:crypto';
import { accessGateSessionTokenHash } from '@hayane/billing-service';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildE2EApp,
  closePool,
  createTestDb,
  insertLinkedSession,
  type PgDbClient,
  TEST_DB_URL,
  truncateAll,
} from './helpers.js';

const hasTestDb = Boolean(TEST_DB_URL);
const E2E_NOW = new Date('2025-06-01T12:00:00Z');
const GATE_CODE = 'e2e-shared-gate-secret';

describe.skipIf(!hasTestDb)('E2E — access gate enforcement', () => {
  let pool: pg.Pool;
  let pgDb: PgDbClient;

  beforeAll(async () => {
    ({ pool, pgDb } = await createTestDb());
  });

  afterAll(async () => {
    await closePool(pool);
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });

  it('verify sets access_gate cookie; subscribe succeeds', async () => {
    const app = buildE2EApp(pgDb, {
      clock: () => E2E_NOW,
      billingConfig: { subscribeGateCode: GATE_CODE },
    });

    const verifyRes = await app.inject({
      method: 'POST',
      url: '/v1/access-gate/verify',
      headers: { 'content-type': 'application/json', origin: 'https://example.com' },
      body: JSON.stringify({ passcode: GATE_CODE }),
    });
    expect(verifyRes.statusCode).toBe(200);
    const setCookie = verifyRes.headers['set-cookie'] as string;
    const m = setCookie.match(/__Host-access_gate=([^;]+)/);
    expect(m).not.toBeNull();
    const gateRaw = m![1];

    const discordUserId = `e2e-gate-${randomUUID().slice(0, 8)}`;
    const { rawToken: linkRaw } = await insertLinkedSession(pgDb, discordUserId, undefined, 3600_000, () => E2E_NOW);

    const subRes = await app.inject({
      method: 'POST',
      url: '/v1/subscriptions',
      headers: { 'content-type': 'application/json', origin: 'https://example.com' },
      cookies: {
        '__Host-link_session': linkRaw,
        '__Host-access_gate': gateRaw,
      },
      body: JSON.stringify({
        planId: 'plan_e2e',
        email: `${discordUserId}@e2e.example.com`,
        payjpToken: 'tok_test_e2e',
        privacyConsented: true,
      }),
    });
    expect(subRes.statusCode).toBe(200);

    const hash = accessGateSessionTokenHash(gateRaw);
    const row = await pool.query('SELECT 1 FROM access_gate_sessions WHERE access_gate_session_token_hash = $1', [
      hash,
    ]);
    expect(row.rowCount).toBe(1);
  });

  it('returns 403 GATE_REQUIRED when gate set but access_gate cookie missing', async () => {
    const app = buildE2EApp(pgDb, {
      clock: () => E2E_NOW,
      billingConfig: { subscribeGateCode: GATE_CODE },
    });
    const discordUserId = `e2e-nogate-${randomUUID().slice(0, 8)}`;
    const { rawToken: linkRaw } = await insertLinkedSession(pgDb, discordUserId, undefined, 3600_000, () => E2E_NOW);

    const subRes = await app.inject({
      method: 'POST',
      url: '/v1/subscriptions',
      headers: { 'content-type': 'application/json', origin: 'https://example.com' },
      cookies: { '__Host-link_session': linkRaw },
      body: JSON.stringify({
        planId: 'plan_e2e',
        email: `${discordUserId}@e2e.example.com`,
        payjpToken: 'tok_test_e2e',
        privacyConsented: true,
      }),
    });
    expect(subRes.statusCode).toBe(403);
    expect((subRes.json() as { errorCode?: string }).errorCode).toBe('GATE_REQUIRED');
  });

  it('returns INVALID_GATE_SESSION when access_gate row is expired in DB', async () => {
    const app = buildE2EApp(pgDb, {
      clock: () => E2E_NOW,
      billingConfig: { subscribeGateCode: GATE_CODE },
    });

    const verifyRes = await app.inject({
      method: 'POST',
      url: '/v1/access-gate/verify',
      headers: { 'content-type': 'application/json', origin: 'https://example.com' },
      body: JSON.stringify({ passcode: GATE_CODE }),
    });
    expect(verifyRes.statusCode).toBe(200);
    const setCookie = verifyRes.headers['set-cookie'] as string;
    const m = setCookie.match(/__Host-access_gate=([^;]+)/);
    expect(m).not.toBeNull();
    const gateRaw = m![1];
    const hash = accessGateSessionTokenHash(gateRaw);
    await pool.query(
      `UPDATE access_gate_sessions SET expires_at = NOW() - INTERVAL '1 hour' WHERE access_gate_session_token_hash = $1`,
      [hash],
    );

    const discordUserId = `e2e-expired-gate-${randomUUID().slice(0, 8)}`;
    const { rawToken: linkRaw } = await insertLinkedSession(pgDb, discordUserId, undefined, 3600_000, () => E2E_NOW);

    const subRes = await app.inject({
      method: 'POST',
      url: '/v1/subscriptions',
      headers: { 'content-type': 'application/json', origin: 'https://example.com' },
      cookies: {
        '__Host-link_session': linkRaw,
        '__Host-access_gate': gateRaw,
      },
      body: JSON.stringify({
        planId: 'plan_e2e',
        email: `${discordUserId}@e2e.example.com`,
        payjpToken: 'tok_test_e2e',
        privacyConsented: true,
      }),
    });
    expect(subRes.statusCode).toBe(403);
    expect((subRes.json() as { errorCode?: string }).errorCode).toBe('INVALID_GATE_SESSION');
  });
});
