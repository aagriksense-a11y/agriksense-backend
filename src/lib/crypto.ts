import crypto from 'crypto';
import { env } from '../config/env';

const key = Buffer.from(env.dataEncryptionKey, 'hex');

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext> (base64url). */
export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decrypt(payload: string): string {
  const [version, iv, tag, ciphertext] = payload.split('.');
  if (version !== 'v1') throw new Error('Unsupported ciphertext version');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

/** Keyed hash for equality lookups on encrypted values (duplicate NIN/account detection). */
export function lookupHash(value: string): string {
  return crypto.createHmac('sha256', env.hashKey).update(value.trim()).digest('hex');
}

export function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function last4(value: string): string {
  return value.slice(-4);
}

export function mask(value: string, visible = 4): string {
  if (value.length <= visible) return value;
  return '*'.repeat(value.length - visible) + value.slice(-visible);
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && ab.length > 0 && crypto.timingSafeEqual(ab, bb);
}
