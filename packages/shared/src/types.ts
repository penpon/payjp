export type CookieName = '__Host-oauth_session' | '__Host-link_session';

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
