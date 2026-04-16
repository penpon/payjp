import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose';

export type CfAccessVerifyResult = { ok: true; email: string } | { ok: false; reason: string };

export type VerifyCfAccessJwtParams = {
  token: string;
  /** e.g. `myteam.cloudflareaccess.com` (no scheme) */
  teamDomain: string;
  /** Application Audience (AUD) tag from the Access application */
  audience: string;
  /**
   * Optional JWKS resolver (unit tests). Production uses Cloudflare team JWKS URL.
   */
  jwks?: JWTVerifyGetKey;
};

/**
 * Verifies Cloudflare Access `Cf-Access-Jwt-Assertion` using the team JWKS.
 * @see https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
 */
export async function verifyCfAccessJwt(params: VerifyCfAccessJwtParams): Promise<CfAccessVerifyResult> {
  const team = params.teamDomain.trim();
  if (!team) {
    return { ok: false, reason: 'empty_team_domain' };
  }
  const issuer = `https://${team}`;
  const JWKS = params.jwks ?? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));

  try {
    const { payload } = await jwtVerify(params.token, JWKS, {
      issuer,
      audience: params.audience,
    });
    const email = payload.email;
    if (typeof email !== 'string' || email.trim() === '') {
      return { ok: false, reason: 'missing_or_invalid_email_claim' };
    }
    return { ok: true, email: email.trim() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: msg };
  }
}
