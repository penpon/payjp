/**
 * sync-service Shell Types
 */
import type { SubscriptionStatus, Member, LogEntry, DbPool } from '@hayane/shared';

export interface PayjpEventInsert {
  id: string;
  event_type: string;
  payload: unknown;
  processing_result: 'processed' | 'ignored' | 'failed';
  member_id?: string;
  ignore_reason?: string;
  fail_reason?: string;
  data_metadata_operation_id?: string | null;
}

export interface PayjpEventRecord {
  id: string;
  event_type: string;
  processing_result: string;
  received_at: Date;
}

export interface WebhookMemberUpdate {
  subscription_status?: SubscriptionStatus;
  payjp_plan_id?: string;
  access_end_at?: Date;
  next_billing_at?: Date;
  last_payjp_event_created_at?: number;
  payjp_subscription_id?: string;
}

export interface MemberImpactLogInsert {
  member_id: string;
  issue_code: string;
  detail?: unknown;
  operation_id?: string;
}

export interface ChargeListResult {
  data: Array<{ id: string; metadata?: Record<string, string> }>;
  has_more: boolean;
}

export interface SubscriptionListResult {
  data: Array<{
    id: string;
    status: string;
    metadata?: Record<string, string>;
    current_period_end?: number;
  }>;
  has_more: boolean;
}

export interface WebhookHandlerDeps {
  db: DbPool;
  payjpWebhookToken: string;
  expectedLivemode: boolean;
  discordGuildId: string;
  discordRoleId: string;
  syncRole: (userId: string, action: 'grant' | 'revoke') => Promise<void>;
  log: (entry: LogEntry) => void;
}

export type { DbPool };

export interface WebhookRequest {
  headers: Record<string, string | undefined>;
  body: unknown;
  remoteIp: string;
}

export interface WebhookResponse {
  status: number;
  body: unknown;
}
