import type {
  CancelFormLinkResponse,
  LinkDiscordResponse,
  MemberInfo,
  MemberRoleState,
  SessionResponse,
  SubscribeResponse,
  SubscriptionInfo,
} from './types.js';

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
  // Treat omitted key (undefined) like null — same as `data.subscription ?? null` at call site
  if (obj.subscription === null || obj.subscription === undefined) return true;
  if (typeof obj.subscription !== 'object' || obj.subscription === null) return false;
  const sub = obj.subscription as Record<string, unknown>;
  return typeof sub.status === 'string' && isNullableString(sub.planId) && isNullableString(sub.accessEndAt);
}

// --- Shared error body parsing ---

interface ParsedErrorBody {
  errorCode: string;
  operationId: string | undefined;
  message: string | undefined;
}

async function parseErrorBody(res: Response): Promise<ParsedErrorBody> {
  const raw: unknown = await res.json().catch((parseErr) => {
    console.warn('[api] Failed to parse error response body:', parseErr);
    return {};
  });
  const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    errorCode: typeof obj.errorCode === 'string' ? obj.errorCode : 'UNKNOWN',
    operationId: typeof obj.operationId === 'string' ? obj.operationId : undefined,
    message: typeof obj.message === 'string' ? obj.message : undefined,
  };
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
    const parsedError = await parseErrorBody(res);
    throw new SubscribeError(
      res.status,
      parsedError.errorCode,
      parsedError.operationId,
      parsedError.message ?? `Subscribe failed: ${res.status}`,
    );
  }

  const data: unknown = await res.json();
  if (!isSubscribeResponse(data)) {
    throw new Error('Invalid subscribe response');
  }
  return data;
}

// --- Cancel ---

export class CancelError extends Error {
  constructor(
    public readonly status: number,
    public readonly errorCode: string,
    public readonly operationId: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'CancelError';
  }
}

function isCancelFormLinkResponse(data: unknown): data is CancelFormLinkResponse {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return obj.ok === true && typeof obj.formUrl === 'string' && typeof obj.expiresAt === 'string';
}

export async function createCancelFormLink(): Promise<CancelFormLinkResponse> {
  const res = await fetch('/v1/subscriptions/cancel/google-form-link', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const parsedError = await parseErrorBody(res);
    throw new CancelError(
      res.status,
      parsedError.errorCode,
      parsedError.operationId,
      parsedError.message ?? `Cancel form link failed: ${res.status}`,
    );
  }

  const data: unknown = await res.json();
  if (!isCancelFormLinkResponse(data)) {
    throw new Error('Invalid cancel form link response');
  }
  return data;
}

// --- Member API (__Host-member_session after subscribe) ---

/** Thrown when GET /v1/members/me fails (non-2xx). Distinct from `null` which means 200 with no member session. */
export class MemberFetchError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'MemberFetchError';
  }
}

export async function getMember(): Promise<MemberInfo | null> {
  const res = await fetch('/v1/members/me', {
    credentials: 'include',
  });
  if (!res.ok) {
    throw new MemberFetchError(res.status, `Member fetch failed: ${res.status}`);
  }
  const data: unknown = await res.json();
  if (typeof data !== 'object' || data === null) return null;
  const obj = data as Record<string, unknown>;
  if (obj.member === null || obj.member === undefined) return null;
  const m = obj.member as Record<string, unknown>;
  const memberId = typeof m.memberId === 'string' ? m.memberId : null;
  if (!memberId) return null;
  const roleRaw = m.roleState;
  let roleState: MemberRoleState | null = null;
  if (roleRaw === 'granted' || roleRaw === 'revoked' || roleRaw === 'unknown') {
    roleState = roleRaw;
  }
  return {
    memberId,
    subscriptionStatus: typeof m.subscriptionStatus === 'string' ? m.subscriptionStatus : null,
    planId: typeof m.planId === 'string' ? m.planId : null,
    accessEndAt: typeof m.accessEndAt === 'string' ? m.accessEndAt : null,
    discordLinked: m.discordLinked === true,
    roleState,
  };
}

export async function linkDiscord(): Promise<LinkDiscordResponse> {
  const res = await fetch('/v1/members/link-discord', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(30000),
  });
  const data: unknown = await res.json().catch(() => ({}));
  const obj = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
  if (!res.ok) {
    return {
      ok: false,
      errorCode: typeof obj.errorCode === 'string' ? obj.errorCode : 'UNKNOWN',
    };
  }
  return {
    ok: true,
    discordUserId: typeof obj.discordUserId === 'string' ? obj.discordUserId : undefined,
    roleGranted: obj.roleGranted === true,
  };
}
