import type { Router } from 'express';
import { env } from './config/env';

const PUBLIC = [
  /^\/auth\/(register|login|oauth|refresh|password\/(forgot|reset))/,
  /^\/consents\/current$/,
  /^\/locations\//,
  /^\/banks$/,
  /^\/health\//,
  /^\/files\//,
  /^\/integrations\//,
];
const MULTIPART = [/^\/documents$/, /^\/users\/me\/photo$/, /^\/imports$/, /^\/ai\/predictions$/];
const IDEMPOTENT = [/^\/imports$/, /^\/imports\/\{jobId\}\/commit$/, /^\/admin\/farm-assignments$/];

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
}

/**
 * Baseline OpenAPI 3.0 document generated from the mounted routers, so the published contract
 * always lists exactly the routes the server exposes. Request/response schemas follow the
 * conventions in docs/API.md (envelope {data, meta?, request_id}; errors {error, request_id}).
 */
export function buildOpenApi(mounts: [string, Router][]) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [prefix, router] of mounts) {
    for (const layer of (router as unknown as { stack: Layer[] }).stack) {
      if (!layer.route) continue;
      const path = `${prefix}${layer.route.path === '/' ? '' : layer.route.path}`.replace(/:([A-Za-z]+)/g, '{$1}');
      const params = [...path.matchAll(/\{([A-Za-z]+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
      for (const method of Object.keys(layer.route.methods)) {
        const isPublic = PUBLIC.some((r) => r.test(path));
        const op: Record<string, unknown> = {
          tags: [path.split('/')[1] === 'admin' ? `admin/${path.split('/')[2]}` : path.split('/')[1]],
          summary: `${method.toUpperCase()} ${path}`,
          parameters: [
            ...params,
            ...(IDEMPOTENT.some((r) => r.test(path)) && method === 'post'
              ? [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 128 } }]
              : []),
          ],
          responses: {
            default: { description: 'Success envelope {data, meta?, request_id} or error envelope {error:{code,message,details?}, request_id}' },
          },
        };
        if (!isPublic) op.security = [{ bearerAuth: [] }];
        if (['post', 'put', 'patch'].includes(method)) {
          op.requestBody = MULTIPART.some((r) => r.test(path)) && method === 'post'
            ? { content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } } } }
            : { content: { 'application/json': { schema: { type: 'object' } } } };
        }
        paths[path] ??= {};
        paths[path][method] = op;
      }
    }
  }
  return {
    openapi: '3.0.3',
    info: { title: 'AgriKSense API', version: '1.0.0', description: 'AgriKSense backend API v1. See docs/API.md for payloads and workflows.' },
    servers: [{ url: `${env.publicBaseUrl}/api/v1` }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
    paths,
  };
}
