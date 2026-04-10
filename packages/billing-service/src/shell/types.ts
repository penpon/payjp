/**
 * Billing Service Shell Layer — Dependency Interfaces
 *
 * 依存性注入により外部 I/O を抽象化する。
 * pure core 関数は src/core/ に実装済み。
 * shell 層はこれらの依存型を受け取りオーケストレーションを実施する。
 */
import type { DbClient } from '@hayane/shared';

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
  createCustomer(params: { email: string; card: string; metadata: Record<string, string> }): Promise<PayjpCustomer>;
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

export type { DbClient };

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
  email: string;
  payjpToken: string;
  planId: string;
  privacyConsented: boolean;
}

export interface CancelRequest {
  origin: string;
  linkSessionToken: string;
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
  | { ok: true; data: import('@hayane/shared').SubscriptionResponse; memberSessionToken?: string }
  | OperationError;

export type CancelResult = { ok: true; data: import('@hayane/shared').CancelResponse } | OperationError;
