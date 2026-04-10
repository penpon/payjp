export type CookieName = '__Host-oauth_session' | '__Host-link_session' | '__Host-member_session';

export type ValidationResult = { ok: true } | { ok: false; reason: string };

export interface OAuthStateRecord {
  id: string;
  state_hash: string;
  oauth_session_hash: string;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
}

export interface LinkSessionRecord {
  id: string;
  link_session_token_hash: string;
  discord_user_id: string;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
}

export interface CookieAttributes {
  name: CookieName;
  secure: true;
  httpOnly: true;
  sameSite: 'Lax';
  path: '/';
  domain?: never;
  maxAge: number;
}

export interface LogEntry {
  timestamp: string;
  service: string;
  endpoint: string;
  result: 'success' | 'failure' | 'error';
  [key: string]: unknown;
}

// billing-service types
export type SubscriptionStatus = 'active' | 'trial' | 'canceled' | 'paused' | 'deleted';
export type InflightOperationType = 'subscribe' | 'cancel';

export interface Member {
  id: string;
  discord_user_id: string | null;
  email: string;
  payjp_customer_id: string | null;
  payjp_subscription_id: string | null;
  payjp_initial_charge_id: string | null;
  payjp_plan_id: string | null;
  subscription_status: SubscriptionStatus | null;
  first_trial_granted_at: Date | null;
  initial_charge_paid_at: Date | null;
  cancel_requested_at: Date | null;
  inflight_operation_id: string | null;
  inflight_operation_type: InflightOperationType | null;
  inflight_operation_started_at: Date | null;
  privacy_consented_at: Date | null;
  access_end_at: Date | null;
  next_billing_at: Date | null;
  role_state: 'granted' | 'revoked' | 'unknown';
  last_synced_at: Date;
  last_payjp_event_created_at: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface SubscriptionResponse {
  ok: true;
  memberId: string;
  subscriptionStatus: SubscriptionStatus;
  planId: string;
  trialApplied: boolean;
  accessEndAt: string;
}

export interface CancelResponse {
  ok: true;
  memberId: string;
  cancelEffectiveAt: string;
  roleRemovalAt: string;
}

export interface MemberSessionRecord {
  id: string;
  member_session_token_hash: string;
  member_id: string;
  expires_at: Date;
  created_at: Date;
}

export type FixedEnvVarValidationResult =
  | { ok: true }
  | { ok: false; invalidVars: Array<{ name: string; expected: string; actual: string | undefined }> };
