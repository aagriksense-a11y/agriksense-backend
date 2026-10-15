import { env } from '../config/env';

type Level = 'debug' | 'info' | 'warn' | 'error';

function write(level: Level, message: string, fields: Record<string, unknown> = {}) {
  if (env.isTest && level !== 'error') return;
  const line = JSON.stringify({ level, time: new Date().toISOString(), msg: message, ...fields });
  if (level === 'error') console.error(line);
  else console.log(line);
}

/** Structured JSON logger; every request log carries request_id. */
export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => write('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write('error', msg, fields),
};
