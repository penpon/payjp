import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/** AES-256-GCM で暗号化。返り値: "iv:authTag:ciphertext" (全て hex) */
export function encryptToken(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('Encryption key must be 32 bytes (64 hex chars)');
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/** AES-256-GCM で復号 */
export function decryptToken(encrypted: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('Encryption key must be 32 bytes (64 hex chars)');
  const parts = encrypted.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted token format');
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const ciphertext = Buffer.from(parts[2], 'hex');
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}
