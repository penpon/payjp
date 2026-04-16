import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { verifyCfAccessJwt } from '../cf-access-jwt.js';

describe('verifyCfAccessJwt', () => {
  it('accepts a valid RS256 JWT from the configured issuer/audience', async () => {
    const teamDomain = 'testteam.cloudflareaccess.com';
    const issuer = `https://${teamDomain}`;
    const audience = 'a1b2c3d4e5f6deadbeef';

    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'unit-test-key';
    const JWKS = createLocalJWKSet({ keys: [jwk] });

    const token = await new SignJWT({ email: 'operator@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'unit-test-key' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setExpirationTime('2h')
      .sign(privateKey);

    const result = await verifyCfAccessJwt({
      token,
      teamDomain,
      audience,
      jwks: JWKS,
    });

    expect(result).toEqual({ ok: true, email: 'operator@example.com' });
  });

  it('rejects wrong audience', async () => {
    const teamDomain = 'testteam.cloudflareaccess.com';
    const issuer = `https://${teamDomain}`;

    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'unit-test-key-2';
    const JWKS = createLocalJWKSet({ keys: [jwk] });

    const token = await new SignJWT({ email: 'operator@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'unit-test-key-2' })
      .setIssuer(issuer)
      .setAudience('wrong-audience')
      .setExpirationTime('2h')
      .sign(privateKey);

    const result = await verifyCfAccessJwt({
      token,
      teamDomain,
      audience: 'expected-audience',
      jwks: JWKS,
    });

    expect(result.ok).toBe(false);
  });
});
