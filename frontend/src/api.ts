import type { SessionResponse } from './types.js';

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
  return typeof data === 'object' && data !== null && typeof (data as Record<string, unknown>).linked === 'boolean';
}

// 401 = 未連携（正常フロー）、403 = Origin不一致、その他 = サーバーエラー
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
