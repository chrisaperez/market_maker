import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.join(import.meta.dirname, '..', '.data');
fs.mkdirSync(dataDir, { recursive: true });

export const DB_PATH = process.env.MM_DB_PATH ?? path.join(dataDir, 'market_maker.db');
// Use a dedicated var (not PORT) so tools that inject PORT for the web dev
// server (e.g. the preview launcher) don't accidentally rebind the API server.
export const PORT = Number(process.env.MM_SERVER_PORT ?? 4000);
export const COOKIE_NAME = 'mm_session';
export const IS_PROD = process.env.NODE_ENV === 'production';

function loadSecret(): string {
  if (process.env.MM_JWT_SECRET) return process.env.MM_JWT_SECRET;
  const p = path.join(dataDir, 'secret');
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch {
    const s = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(p, s, { mode: 0o600 });
    return s;
  }
}

export const JWT_SECRET = loadSecret();
