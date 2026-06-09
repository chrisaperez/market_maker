import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { nanoid } from 'nanoid';
import type { User } from '@mm/shared';
import { COOKIE_NAME, IS_PROD, JWT_SECRET } from './config.js';
import { db } from './db.js';

const insertUser = db.prepare('INSERT INTO users(id, username, created_at) VALUES (?, ?, ?)');
const selectUser = db.prepare('SELECT id, username, created_at FROM users WHERE id = ?');
const selectUserByName = db.prepare('SELECT id, username, created_at FROM users WHERE username = ? COLLATE NOCASE');
const updateUsername = db.prepare('UPDATE users SET username = ? WHERE id = ?');

interface UserRow {
  id: string;
  username: string | null;
  created_at: number;
}

function rowToUser(r: UserRow): User {
  return { id: r.id, username: r.username, createdAt: r.created_at };
}

export function createUser(): User {
  const id = nanoid();
  insertUser.run(id, null, Date.now());
  return { id, username: null, createdAt: Date.now() };
}

export function getUser(id: string): User | null {
  const r = selectUser.get(id) as UserRow | undefined;
  return r ? rowToUser(r) : null;
}

export function getUserByUsername(username: string): User | null {
  const r = selectUserByName.get(username) as UserRow | undefined;
  return r ? rowToUser(r) : null;
}

export class UsernameError extends Error {}

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,20}$/;

export function validateUsername(username: string): string {
  const trimmed = username.trim();
  if (!USERNAME_RE.test(trimmed)) {
    throw new UsernameError('Username must be 3-20 letters, numbers, underscores or dashes.');
  }
  return trimmed;
}

/** Sets a user's username, enforcing global uniqueness. Idempotent if unchanged. */
export function setUsername(userId: string, username: string): User {
  const clean = validateUsername(username);
  const existing = getUserByUsername(clean);
  if (existing && existing.id !== userId) {
    throw new UsernameError('That username is already taken.');
  }
  updateUsername.run(clean, userId);
  return getUser(userId)!;
}

export function issueToken(userId: string): string {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '365d' });
}

export function verifyToken(token: string | undefined): string | null {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { sub?: string };
    if (payload.sub && getUser(payload.sub)) return payload.sub;
    return null;
  } catch {
    return null;
  }
}

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: IS_PROD, // require HTTPS in production (Fly terminates TLS)
  maxAge: 365 * 24 * 60 * 60 * 1000,
  path: '/',
};

/**
 * Ensures every /api request carries an identity. Reuses a valid session
 * cookie, otherwise mints a fresh anonymous user and sets the cookie.
 * The resolved user id is placed on res.locals.userId.
 */
export function ensureSession(req: Request, res: Response, next: NextFunction): void {
  let userId = verifyToken(req.cookies?.[COOKIE_NAME]);
  if (!userId) {
    const user = createUser();
    userId = user.id;
    res.cookie(COOKIE_NAME, issueToken(userId), COOKIE_OPTS);
  }
  res.locals.userId = userId;
  next();
}

export function userIdOf(res: Response): string {
  return res.locals.userId as string;
}
