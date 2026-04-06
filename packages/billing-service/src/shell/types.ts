/**
 * Billing Service Shell Layer — Dependency Interfaces
 *
 * 依存性注入により外部 I/O を抽象化する。
 * pure core 関数は src/core/ に実装済み。
 * shell 層はこれらの依存型を受け取りオーケストレーションを実施する。
 */
import type { Member, LinkSessionRecord } from '@hayane/shared';

// PAY.JP レスポンス型

export interface PayjpToken {
  id: string;
  used: boolean;
  three_d_secure_status: string | null;
  card: {
    id: string;
  };
}

export interface PayjpCustomer {
  id: string;
  metadata: Record<string, string>;
}

export interface PayjpCharge {
  id: string;
  amount: number;
  paid: boolean;
  metadata: Record<string, string>;
}

export interface PayjpSubscription {
  id: string;
  status: string;
  current_period_end: number;
  trial_end: number | null;
  plan: {
    id: string;
    interval: string;
  };
  metadata: Record<string, string>;
}

// クライアントインターフェース

export interface PayjpClient {
  fetchToken(tokenId: string): Promise<PayjpToken>;
  createCustomer(params: {
    email: string;
    card: string;
    metadata: Record<string, string>;
  }): Promise<PayjpCustomer>;
  createCharge(params: {
    customer: string;
    amount: number;
    currency: string;
    metadata: Record<string, string>;
  }): Promise<PayjpCharge>;
  createSubscription(params: {
    customer: string;
    plan: string;
    trial_end?: number;
    metadata: Record<string, string>;
  }): Promise<PayjpSubscription>;
  cancelSubscription(subscriptionId: string): Promise<PayjpSubscription>;
  fetchCustomer(customerId: string): Promise<PayjpCustomer>;
  fetchCharge(chargeId: string): Promise<PayjpCharge>;
  fetchSubscription(subscriptionId: string): Promise<PayjpSubscription>;
}

export interface DiscordCheckResult {
  isMember: boolean;
  canAssignRole: boolean;
}

export interface DiscordClient {
  checkMembership(guildId: string, discordUserId: string): Promise<DiscordCheckResult>;
  assignRole(guildId: string, discordUserId: string, roleId: string): Promise<void>;
}

export interface DbClient {
  findMemberByDiscordUserId(discordUserId: string): Promise<Member | null>;
  upsertProvisionalMember(discordUserId: string, email: string): Promise<Member>;
  findLinkSession(tokenHash: string): Promise<LinkSessionRecord | null>;
  consumeLinkSession(tokenHash: string, now: Date): Promise<void>;
  setInflightOperation(memberId: string, operationId: string, operationType: 'subscribe' | 'cancel', now: Date): Promise<void>;
  clearInflightOperation(memberId: string): Promise<void>;
  updateMemberCustomerId(memberId: string, payjpCustomerId: string): Promise<void>;
  updateMemberChargeId(memberId: string, chargeId: string, paidAt: Date): Promise<void>;
  updateMemberAfterSubscribe(memberId: string, params: {
    payjp_initial_charge_id: string | null;
    initial_charge_paid_at: Date | null;
    payjp_subscription_id: string;
    payjp_plan_id: string;
    subscription_status: 'active' | 'trial';
    first_trial_granted_at: Date | null;
    access_end_at: Date;
    next_billing_at: Date;
    role_state: 'granted';
    last_synced_at: Date;
    inflight_operation_id: null;
    inflight_operation_type: null;
    inflight_operation_started_at: null;
  }): Promise<Member>;
  updateMemberAfterCancel(memberId: string, params: {
    cancel_requested_at: Date;
    subscription_status: 'canceled';
    access_end_at: Date;
    inflight_operation_id: null;
    inflight_operation_type: null;
    inflight_operation_started_at: null;
  }): Promise<Member>;
  acquireAdvisoryLock(key: string): Promise<boolean>;
  releaseAdvisoryLock(key: string): Promise<void>;
}

export interface BillingConfig {
  frontendBaseUrl: string;
  allowedPlanIds: string[];
  discordGuildId: string;
  discordPaidRoleId: string;
  initialChargeAmount: number;
  initialChargeAmountCurrency: string;
}

export interface BillingDeps {
  db: DbClient;
  payjp: PayjpClient;
  discord: DiscordClient;
  config: BillingConfig;
  clock: () => Date;
  generateOperationId: () => string;
}

// リクエスト型

export interface SubscribeRequest {
  origin: string;
  linkSessionToken: string;
  discordUserId: string;
  email: string;
  payjpToken: string;
  planId: string;
}

export interface CancelRequest {
  origin: string;
  linkSessionToken: string;
  discordUserId: string;
}

// レスポンス型

export interface OperationError {
  ok: false;
  statusCode: number;
  errorCode: string;
  message: string;
  operationId?: string;
}

export type SubscribeResult =
  | { ok: true; data: import('@hayane/shared').SubscriptionResponse }
  | OperationError;

export type CancelResult =
  | { ok: true; data: import('@hayane/shared').CancelResponse }
  | OperationError;
