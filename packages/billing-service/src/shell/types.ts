/**
 * Billing Service Shell Layer — Dependency Interfaces
 *
 * 依存性注入により外部 I/O を抽象化する。
 * pure core 関数は src/core/ に実装済み。
 * shell 層はこれらの依存型を受け取りオーケストレーションを実施する。
 */
import type { CancelFormLinkResponse, DbClient } from '@hayane/shared';

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

/** Result of Add Guild Member (guilds.join). Discord returns 201 when the user is newly added (roles from body apply) and 204 when already in the guild (roles are not applied). */
export interface AddGuildMemberResult {
  joinedNew: boolean;
}

export interface DiscordClient {
  /** When `roleId` is set, `canAssignRole` reflects whether the bot can assign that specific role (plan tier). */
  checkMembership(guildId: string, discordUserId: string, roleId?: string): Promise<DiscordCheckResult>;
  assignRole(guildId: string, discordUserId: string, roleId: string): Promise<void>;
  removeRole(guildId: string, discordUserId: string, roleId: string): Promise<void>;
  addMemberToGuild(
    guildId: string,
    discordUserId: string,
    accessToken: string,
    roleId?: string,
  ): Promise<AddGuildMemberResult>;
  revokeToken(accessToken: string): Promise<void>;
}

export type { DbClient };

export interface BillingConfig {
  frontendBaseUrl: string;
  allowedPlanIds: string[];
  discordGuildId: string;
  planRoleMapping: Record<string, string>;
  initialChargeAmount: number;
  initialChargeAmountCurrency: string;
  discordTokenEncryptionKey?: string;
  googleFormCancelBaseUrl: string;
  googleFormCancelEmailEntryId: string;
  googleFormCancelTokenEntryId: string;
  googleFormCancelSecret: string;
  googleFormCancelTokenSecret: string;
  googleFormCancelTokenTtlSeconds: number;
  /** Months of notice before `access_end_at` (JST calendar) when self-serve cancel opens; MVP fixed to 1. */
  cancelNoticeCycles: number;
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
  /** When set (e.g. __Host-link_session), lock and member resolution use Discord identity. */
  linkSessionToken?: string;
}

export interface CancelRequest {
  origin: string;
  linkSessionToken: string;
}

export interface CancelFormLinkRequest {
  origin: string;
  memberSessionToken: string;
}

export interface GoogleCancelSubmitRequest {
  email: string;
  name: string;
  reason: string;
  token: string;
  secret: string;
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

export type CancelFormLinkResult = { ok: true; data: CancelFormLinkResponse } | OperationError;

export type CancelResult = { ok: true; data: import('@hayane/shared').CancelResponse } | OperationError;
