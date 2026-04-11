import type { CookieAttributes, CookieName } from './types.js';

/** __Host-Cookie の固定属性を構築する */
export function buildCookieAttributes(name: CookieName, maxAge: number): CookieAttributes {
  return {
    name,
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge,
  };
}

/** CookieAttributes を Set-Cookie ヘッダ文字列にシリアライズする */
export function serializeCookieAttributes(attrs: CookieAttributes, value: string): string {
  const parts: string[] = [`${attrs.name}=${value}`];
  if (attrs.maxAge !== undefined) parts.push(`Max-Age=${attrs.maxAge}`);
  if (attrs.path) parts.push(`Path=${attrs.path}`);
  if (attrs.secure) parts.push('Secure');
  if (attrs.httpOnly) parts.push('HttpOnly');
  if (attrs.sameSite) parts.push(`SameSite=${attrs.sameSite}`);
  return parts.join('; ');
}
