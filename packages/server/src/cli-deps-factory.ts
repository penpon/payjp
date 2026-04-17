/**
 * Shared PAY.JP adapter wiring and {@link CliDeps} assembly for `main.ts` and `resync-cli.ts`.
 */
import type { REST } from '@discordjs/rest';
import type { CliDeps } from '@hayane/sync-service';
import Payjp from 'payjp';

/** PAY.JP SDK (export=) — cast shape used for CLI list/create helpers. */
export type PayjpApiLike = Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;

export function createPayjpApi(secretKey: string): PayjpApiLike {
  return (Payjp as unknown as (key: string) => PayjpApiLike)(secretKey);
}

export function toMetadata(raw: unknown): Record<string, string> {
  if (raw === null || raw === undefined || typeof raw !== 'object') return {};
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v)]));
}

export type ParseSubscriptionPlanConfigResult =
  | {
      ok: true;
      allowedPlanIds: string[];
      planRoleMapping: Record<string, string>;
      planInitialChargeAmounts: Record<string, number>;
    }
  | { ok: false; message: string };

/**
 * Parses plan IDs, Discord role mapping, and initial charge amounts from env.
 * Aligns validation between the HTTP server and the manual resync CLI.
 */
export function parseSubscriptionPlanConfig(
  env: Pick<Record<string, string>, 'PAYJP_PLAN_IDS' | 'DISCORD_PLAN_ROLE_IDS' | 'PAYJP_PLAN_INITIAL_CHARGE_AMOUNTS'>,
  label: string,
): ParseSubscriptionPlanConfigResult {
  const allowedPlanIds = env.PAYJP_PLAN_IDS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowedPlanIds.length === 0) {
    return { ok: false, message: `[${label}] PAYJP_PLAN_IDS must contain at least one plan ID\n` };
  }

  const discordPlanRoleIds = env.DISCORD_PLAN_ROLE_IDS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (discordPlanRoleIds.length !== allowedPlanIds.length) {
    return {
      ok: false,
      message: `[${label}] DISCORD_PLAN_ROLE_IDS must have the same number of comma-separated entries as PAYJP_PLAN_IDS (expected ${allowedPlanIds.length}, got ${discordPlanRoleIds.length})\n`,
    };
  }

  const planRoleMapping: Record<string, string> = Object.fromEntries(
    allowedPlanIds.map((pid, i) => [pid, discordPlanRoleIds[i] as string]),
  );

  const planInitialChargeParts = env.PAYJP_PLAN_INITIAL_CHARGE_AMOUNTS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (planInitialChargeParts.length !== allowedPlanIds.length) {
    return {
      ok: false,
      message: `[${label}] PAYJP_PLAN_INITIAL_CHARGE_AMOUNTS must have the same number of comma-separated integers as PAYJP_PLAN_IDS (expected ${allowedPlanIds.length}, got ${planInitialChargeParts.length})\n`,
    };
  }

  const planInitialChargeAmountsParsed = planInitialChargeParts.map((s) => Number.parseInt(s, 10));
  if (planInitialChargeAmountsParsed.some((n) => !Number.isInteger(n) || n <= 0)) {
    return {
      ok: false,
      message: `[${label}] PAYJP_PLAN_INITIAL_CHARGE_AMOUNTS must be positive integers: ${env.PAYJP_PLAN_INITIAL_CHARGE_AMOUNTS}\n`,
    };
  }

  const planInitialChargeAmounts: Record<string, number> = Object.fromEntries(
    allowedPlanIds.map((pid, i) => [pid, planInitialChargeAmountsParsed[i] as number]),
  );

  return { ok: true, allowedPlanIds, planRoleMapping, planInitialChargeAmounts };
}

export function buildCliDepsFromPayjpApi(params: {
  db: CliDeps['db'];
  payjpApi: PayjpApiLike;
  discordRest: REST;
  discordGuildId: string;
  planRoleMapping: Record<string, string>;
  planInitialChargeAmounts: Record<string, number>;
  log?: CliDeps['log'];
  now?: CliDeps['now'];
}): CliDeps {
  const { db, payjpApi, discordRest, discordGuildId, planRoleMapping, planInitialChargeAmounts } = params;
  const log = params.log ?? ((entry) => console.log(JSON.stringify(entry)));
  const now = params.now ?? (() => new Date());

  async function syncRole(userId: string, action: 'grant' | 'revoke', roleId: string): Promise<void> {
    const endpoint = `/guilds/${discordGuildId}/members/${userId}/roles/${roleId}` as const;
    let lastError: unknown;
    for (const delayMs of [0, 1000, 2000]) {
      if (delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
      try {
        if (action === 'grant') {
          await discordRest.put(endpoint, { signal: AbortSignal.timeout(1000) });
        } else {
          await discordRest.delete(endpoint, { signal: AbortSignal.timeout(1000) });
        }
        return;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  const listPayjpCharges: CliDeps['listPayjpCharges'] = async (chargeParams, offset) => {
    const r = (await payjpApi.charges.list({
      customer: chargeParams.customer,
      since: chargeParams.since,
      until: chargeParams.until,
      limit: chargeParams.limit,
      offset,
    })) as { data: Array<Record<string, unknown>>; has_more: boolean };
    return {
      data: r.data.map((ch) => ({
        id: ch.id as string,
        paid: ch.paid === true,
        metadata: toMetadata(ch.metadata),
      })),
      has_more: r.has_more,
    };
  };

  const listPayjpSubscriptions: CliDeps['listPayjpSubscriptions'] = async (customerId, offset) => {
    const r = (await payjpApi.subscriptions.list({
      customer: customerId,
      limit: 100,
      offset,
    })) as { data: Array<Record<string, unknown>>; has_more: boolean };
    return {
      data: r.data.map((s) => ({
        id: s.id as string,
        status: s.status as string,
        metadata: toMetadata(s.metadata),
        current_period_end: s.current_period_end as number | undefined,
      })),
      has_more: r.has_more,
    };
  };

  const getPayjpSubscription: CliDeps['getPayjpSubscription'] = async (subscriptionId) => {
    try {
      return (await payjpApi.subscriptions.retrieve(subscriptionId)) as Record<string, unknown>;
    } catch (err) {
      // H3 fix: transient PAY.JP エラーを silent null 化せず log 出力。
      // CLI recovery の fail-close 判定で `null` を「未存在」と誤解する経路を防ぐ。
      log({
        timestamp: now().toISOString(),
        service: 'cli-deps-factory',
        endpoint: 'payjp/subscriptions.retrieve',
        result: 'error',
        subscription_id: subscriptionId,
        error: String(err),
      });
      return null;
    }
  };

  const createPayjpCharge: CliDeps['createPayjpCharge'] = async (chargeParams) => {
    const ch = (await payjpApi.charges.create(chargeParams)) as Record<string, unknown>;
    return { id: ch.id as string };
  };

  const createPayjpSubscription: CliDeps['createPayjpSubscription'] = async (subParams) => {
    const s = (await payjpApi.subscriptions.create(subParams)) as Record<string, unknown>;
    return { id: s.id as string, status: s.status as string };
  };

  const cancelPayjpSubscription: CliDeps['cancelPayjpSubscription'] = async (subscriptionId) =>
    (await payjpApi.subscriptions.cancel(subscriptionId)) as Record<string, unknown>;

  return {
    db,
    getPayjpSubscription,
    listPayjpCharges,
    listPayjpSubscriptions,
    createPayjpCharge,
    createPayjpSubscription,
    cancelPayjpSubscription,
    syncRole,
    planRoleMapping,
    planInitialChargeAmounts,
    initialChargeCurrency: 'jpy',
    log,
    now,
  };
}
