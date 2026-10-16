import zlib from 'zlib';
import request from 'supertest';
import { createApp } from '../src/app';
import { prisma } from '../src/config/prisma';
import { outbox } from '../src/services/notification.service';
import { pendingJobs } from '../src/modules/verifications.routes';

export const app = createApp();
export const api = () => request(app);
export { prisma, outbox };

let counter = 0;
const uniq = () => `${Date.now().toString().slice(-6)}${(counter++).toString().padStart(3, '0')}`;
export const uniquePhone = () => `+23480${uniq().slice(-8)}`;
export const uniqueEmail = (prefix = 'user') => `${prefix}.${uniq()}@test.local`;
export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
export const PASSWORD = 'Passw0rd!x';

export async function flushVerifications() {
  await Promise.all([...pendingJobs]);
}

export async function login(identifier: string, password = PASSWORD) {
  const res = await api().post('/api/v1/auth/login').send({ identifier, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.tokens.access_token as string;
}

export const adminToken = () => login('admin@test.local', 'AdminPass123');

export async function registerFarmer(overrides: Record<string, unknown> = {}) {
  const phone = uniquePhone();
  const res = await api()
    .post('/api/v1/auth/register/farmers')
    .send({ first_name: 'Ada', last_name: 'Okoro', phone, email: null, password: PASSWORD, consent_version: 'v1', consent_accepted: true, ...overrides });
  if (res.status !== 201) throw new Error(`farmer registration failed: ${JSON.stringify(res.body)}`);
  return { ...res.body.data, phone, token: res.body.data.tokens.access_token as string };
}

export async function registerDco() {
  const phone = uniquePhone();
  const email = uniqueEmail('dco');
  const res = await api().post('/api/v1/auth/register/dcos').send({ first_name: 'Musa', last_name: 'Bello', phone, email, password: PASSWORD });
  if (res.status !== 201) throw new Error(`dco registration failed: ${JSON.stringify(res.body)}`);
  return { ...res.body.data, phone, email, token: res.body.data.tokens.access_token as string };
}

export async function registerOrganization(isRegistered = true) {
  const email = uniqueEmail('org');
  const res = await api()
    .post('/api/v1/auth/register/organizations')
    .send({ organization_name: `Coop ${uniq()}`, email, password: PASSWORD, is_registered: isRegistered });
  if (res.status !== 201) throw new Error(`org registration failed: ${JSON.stringify(res.body)}`);
  return { ...res.body.data, email, token: res.body.data.tokens.access_token as string };
}

export async function stateAndLga(code = 'FC', lgaName = 'Gwagwalada') {
  const state = await prisma.state.findUniqueOrThrow({ where: { code } });
  const lga = await prisma.lga.findUniqueOrThrow({ where: { stateId_name: { stateId: state.id, name: lgaName } } });
  return { stateId: state.id, lgaId: lga.id };
}

// ── Binary fixtures ──
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** A real, decodable RGB PNG of the given size (seeded colour so different seeds hash differently). */
export function png(width = 64, height = 64, seed = 1) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3, seed % 256);
  row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
export const pdf = () => Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
