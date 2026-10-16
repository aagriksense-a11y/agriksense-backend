import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { env } from '../config/env';
import { ApiError } from './errors';

export type SniffedType = 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';

/** Detect file type from magic bytes — never trust the client-declared MIME type. */
export function sniffMime(buf: Buffer): SniffedType | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 5 && buf.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

/** Read pixel dimensions from the image header, proving the upload is a decodable image. */
export function imageDimensions(buf: Buffer): { width: number; height: number } | null {
  const type = sniffMime(buf);
  try {
    if (type === 'image/png') {
      if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (type === 'image/jpeg') {
      let offset = 2;
      while (offset + 9 < buf.length) {
        if (buf[offset] !== 0xff) return null;
        const marker = buf[offset + 1];
        const length = buf.readUInt16BE(offset + 2);
        // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC)
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
        }
        offset += 2 + length;
      }
      return null;
    }
    if (type === 'image/webp') {
      const chunk = buf.toString('ascii', 12, 16);
      if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
      if (chunk === 'VP8X') return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    }
  } catch {
    return null;
  }
  return null;
}

export const IMAGE_TYPES: SniffedType[] = ['image/jpeg', 'image/png', 'image/webp'];
export const DOCUMENT_TYPES: SniffedType[] = [...IMAGE_TYPES, 'application/pdf'];

export function assertFileType(file: Express.Multer.File | undefined, allowed: SniffedType[]) {
  if (!file) throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid request', [{ field: 'file', reason: 'required' }]);
  const sniffed = sniffMime(file.buffer);
  if (!sniffed || !allowed.includes(sniffed)) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', `File must be one of: ${allowed.join(', ')}`);
  }
  if (IMAGE_TYPES.includes(sniffed) && !imageDimensions(file.buffer)) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'File is not a decodable image');
  }
  return sniffed;
}

// ── Private storage (local disk; swap for S3/GCS by replacing these three functions) ──

const root = () => path.resolve(env.storageDir);

export async function putObject(buf: Buffer, ext: string): Promise<string> {
  const now = new Date();
  const key = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}.${ext}`;
  const full = path.join(root(), key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, buf, { mode: 0o600 });
  return key;
}

export async function getObject(key: string): Promise<Buffer> {
  const full = path.join(root(), key);
  if (!full.startsWith(root())) throw new Error('Invalid storage key');
  return fs.readFile(full);
}

export async function deleteObject(key: string): Promise<void> {
  await fs.rm(path.join(root(), key), { force: true });
}

export const extensionFor = (mime: SniffedType) =>
  ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' })[mime];

// ── Short-lived signed URLs ──

function sign(payload: string) {
  return crypto.createHmac('sha256', env.hashKey).update(`file:${payload}`).digest('base64url');
}

export function signedFileUrl(documentId: string, ttlSeconds = env.fileUrlTtlSeconds) {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const payload = Buffer.from(JSON.stringify({ d: documentId, e: Math.floor(expiresAt.getTime() / 1000) })).toString('base64url');
  const token = `${payload}.${sign(payload)}`;
  return { url: `${env.publicBaseUrl}/api/v1/files/${token}`, expires_at: expiresAt.toISOString() };
}

export function verifyFileToken(token: string): string | null {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = sign(payload);
  if (expected.length !== signature.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;
  try {
    const { d, e } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof d !== 'string' || typeof e !== 'number' || e * 1000 < Date.now()) return null;
    return d;
  } catch {
    return null;
  }
}
