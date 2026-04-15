/**
 * E2E 用モック（Vitest 非依存）— `e2e-serve.ts` と Vitest `helpers.ts` の両方から利用する。
 */
import { createHash, randomUUID } from 'node:crypto';
import type { AuthConfig } from '@hayane/auth-service';
import type { BillingConfig, BillingDeps, DiscordClient, PayjpClient } from '@hayane/billing-service';
import { createPgPool, type PgDbClient } from '@hayane/shared';
import type { WebhookHandlerDeps } from '@hayane/sync-service';
import type pg from 'pg';
import { buildApp } from '../app.js';
import type { SyncDeps } from '../routes/sync.routes.js';

const PAYJP_TOKEN_ID_PATTERN = /^tok_[0-9a-zA-Z_]+$/;

export const E2E_PLAN_ROLE_MAPPING: Record<string, string> = {
  plan_e2e: 'role-e2e-test',
  plan_e2e_standard: 'role-e2e-standard',
  plan_e2e_premium: 'role-e2e-premium',
};

export const E2E_BILLING_CONFIG: BillingConfig = {
  frontendBaseUrl: 'https://example.com',
  allowedPlanIds: ['plan_e2e', 'plan_e2e_standard', 'plan_e2e_premium'],
  discordGuildId: 'guild-e2e-test',
  planRoleMapping: E2E_PLAN_ROLE_MAPPING,
  planInitialChargeAmounts: {
    plan_e2e: 1000,
    plan_e2e_standard: 2000,
    plan_e2e_premium: 3000,
  },
  initialChargeAmount: 1000,
  initialChargeAmountCurrency: 'jpy',
  googleFormCancelBaseUrl: 'https://docs.google.com/forms/d/e/e2e-test-form/viewform',
  googleFormCancelEmailEntryId: '1111111111',
  googleFormCancelTokenEntryId: '2222222222',
  googleFormCancelSecret: 'e2e-google-secret',
  googleFormCancelTokenSecret: 'e2e-google-token-secret',
  googleFormCancelTokenTtlSeconds: 900,
  accessGateSessionTtlSeconds: 86400,
};

export const E2E_WEBHOOK_TOKEN = 'whsec_e2e_test_token';

export const E2E_AUTH_CONFIG = {
  frontendBaseUrl: 'https://example.com',
  discordClientId: 'test-client-id',
  discordClientSecret: 'test-client-secret',
  discordRedirectUri: 'https://api.example.com/v1/auth/discord/callback',
};

export function makePlainPayjpClient(): PayjpClient {
  const trialEnd = Math.floor(Date.now() / 1000) + 30 * 86400;
  return {
    async fetchToken(tokenId: string) {
      if (!PAYJP_TOKEN_ID_PATTERN.test(tokenId)) {
        throw new Error('No such token');
      }
      return {
        id: 'tok_test_e2e',
        used: false,
        three_d_secure_status: 'verified',
        card: { id: 'car_test_e2e' },
      };
    },
    async createCustomer(params) {
      const email = params.email ?? '';
      const suffix = email ? createHash('sha256').update(email).digest('hex').slice(0, 12) : randomUUID().slice(0, 12);
      return { id: `cus_test_e2e_${suffix}`, metadata: params.metadata };
    },
    async createCharge(params) {
      return {
        id: `ch_test_e2e_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        amount: params.amount,
        paid: true,
        metadata: params.metadata,
      };
    },
    async createSubscription(params) {
      return {
        id: `sub_test_e2e_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        status: 'trial',
        current_period_end: trialEnd,
        trial_end: trialEnd,
        plan: { id: params.plan, interval: 'month' },
        metadata: params.metadata,
      };
    },
    async cancelSubscription(subscriptionId) {
      return {
        id: subscriptionId,
        status: 'canceled',
        // Keep cancel responses aligned with the active subscription window so tests
        // don't accidentally shrink access_end_at to "now".
        current_period_end: trialEnd,
        trial_end: null,
        plan: { id: 'plan_e2e', interval: 'month' },
        metadata: {},
      };
    },
    async fetchCustomer() {
      return { id: 'cus_test_e2e', metadata: {} };
    },
    async fetchCharge() {
      return {
        id: 'ch_test_e2e',
        amount: 1000,
        paid: true,
        metadata: {},
      };
    },
    async fetchSubscription() {
      return {
        id: 'sub_test_e2e',
        status: 'trial',
        current_period_end: trialEnd,
        trial_end: trialEnd,
        plan: { id: 'plan_e2e', interval: 'month' },
        metadata: {},
      };
    },
  };
}

export function makePlainDiscordClient(): DiscordClient {
  return {
    async checkMembership() {
      return { isMember: true, canAssignRole: true };
    },
    async assignRole() {},
    async removeRole() {},
    async addMemberToGuild() {
      return { joinedNew: true };
    },
    async revokeToken() {},
  };
}

export function buildSyncDepsForE2EPlain(
  pool: pg.Pool,
  syncRole: (userId: string, action: 'grant' | 'revoke', roleId: string) => Promise<void> = async () => {},
): SyncDeps {
  const webhookDeps: WebhookHandlerDeps = {
    db: createPgPool(pool),
    payjpWebhookToken: E2E_WEBHOOK_TOKEN,
    expectedLivemode: false,
    discordGuildId: E2E_BILLING_CONFIG.discordGuildId,
    planRoleMapping: E2E_PLAN_ROLE_MAPPING,
    syncRole,
    log: () => {},
  };
  return { webhookDeps };
}

export interface E2EAppOverridesPlain {
  payjp?: PayjpClient;
  discord?: DiscordClient;
  syncDeps?: SyncDeps;
  clock?: () => Date;
  generateOperationId?: () => string;
  billingConfig?: Partial<BillingConfig>;
  authConfig?: Partial<Omit<AuthConfig, 'db'>>;
}

export function buildE2EAppPlain(pgDb: PgDbClient, overrides: E2EAppOverridesPlain = {}) {
  const config = { ...E2E_BILLING_CONFIG, ...overrides.billingConfig };
  const billingDeps: BillingDeps = {
    db: pgDb,
    payjp: overrides.payjp ?? makePlainPayjpClient(),
    discord: overrides.discord ?? makePlainDiscordClient(),
    config,
    clock: overrides.clock ?? (() => new Date()),
    generateOperationId: overrides.generateOperationId ?? (() => randomUUID()),
  };

  const auth: AuthConfig = {
    ...E2E_AUTH_CONFIG,
    ...overrides.authConfig,
    db: pgDb,
  };

  return buildApp(auth, billingDeps, overrides.syncDeps);
}
