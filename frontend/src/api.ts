import type { SessionResponse, SubscribeResponse, SubscriptionInfo } from './types.js';

// --- Session ---

export class SessionCheckError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SessionCheckError';
  }
}

function isSessionResponse(data: unknown): data is SessionResponse {
  if (typeof data !== 'object' || data === null) return false;
  const o = data as Record<string, unknown>;
  if (typeof o.linked !== 'boolean') return false;
  if (o.linked === true) {
    return typeof o.discordUserId === 'string' && o.discordUserId.length > 0;
  }
  return true;
}

export async function checkSession(): Promise<SessionResponse> {
  const res = await fetch('/v1/auth/discord/session', {
    credentials: 'include',
  });
  if (!res.ok) {
    throw new SessionCheckError(res.status, `Session check failed: ${res.status}`);
  }
  const data: unknown = await res.json();
  if (!isSessionResponse(data)) {
    throw new Error('Invalid session response');
  }
  return data;
}

export function startOAuth(): void {
  window.location.href = '/v1/auth/discord/start';
}

// --- Subscription status ---

export class SubscriptionStatusError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SubscriptionStatusError';
  }
}

async function readSubscriptionStatusErrorMessage(res: Response, fallbackMessage: string): Promise<string> {
  const body: unknown = await res.json().catch((parseErr) => {
    console.warn('[api] Failed to parse subscription status error body:', parseErr);
    return {};
  });
  const obj = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  return typeof obj.message === 'string' ? obj.message : fallbackMessage;
}

export async function fetchSubscriptionStatus(): Promise<SubscriptionInfo | null> {
  const res = await fetch('/v1/subscriptions/status', {
    credentials: 'include',
  });
  if (!res.ok) {
    const fallbackMessage =
      res.status === 503 ? '購読状況を確認できませんでした。' : `Subscription status check failed: ${res.status}`;
    const message = await readSubscriptionStatusErrorMessage(res, fallbackMessage);
    throw new SubscriptionStatusError(res.status, message);
  }
  const data: unknown = await res.json();
  if (!isSubscriptionStatusResponse(data)) {
    throw new Error('Invalid subscription status response');
  }
  return data.subscription ?? null;
}

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

function isSubscriptionStatusResponse(data: unknown): data is { subscription: SubscriptionInfo | null } {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (obj.subscription === null || obj.subscription === undefined) return true;
  if (typeof obj.subscription !== 'object' || obj.subscription === null) return false;
  const sub = obj.subscription as Record<string, unknown>;
  return typeof sub.status === 'string' && isNullableString(sub.planId) && isNullableString(sub.accessEndAt);
}

// --- Subscribe ---

export class SubscribeError extends Error {
  constructor(
    public readonly status: number,
    public readonly errorCode: string,
    public readonly operationId: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'SubscribeError';
  }
}

function isSubscribeResponse(data: unknown): data is SubscribeResponse {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    obj.ok === true &&
    typeof obj.memberId === 'string' &&
    typeof obj.subscriptionStatus === 'string' &&
    typeof obj.planId === 'string' &&
    typeof obj.trialApplied === 'boolean' &&
    typeof obj.accessEndAt === 'string'
  );
}

export async function createSubscription(body: {
  planId: string;
  email: string;
  payjpToken: string;
  privacyConsented: boolean;
}): Promise<SubscribeResponse> {
  const res = await fetch('/v1/subscriptions', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const errorBody: unknown = await res.json().catch(() => ({}));
    const obj = typeof errorBody === 'object' && errorBody !== null ? (errorBody as Record<string, unknown>) : {};
    throw new SubscribeError(
      res.status,
      typeof obj.errorCode === 'string' ? obj.errorCode : 'UNKNOWN',
      typeof obj.operationId === 'string' ? obj.operationId : undefined,
      typeof obj.message === 'string' ? obj.message : `Subscribe failed: ${res.status}`,
    );
  }

  const data: unknown = await res.json();
  if (!isSubscribeResponse(data)) {
    throw new Error('Invalid subscribe response');
  }
  return data;
}
