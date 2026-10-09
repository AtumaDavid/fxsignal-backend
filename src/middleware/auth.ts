import type { NextFunction, Request, Response } from 'express';
import { verifyToken, type AuthTokenPayload } from '../lib/auth.js';
import { isAdminEmail } from '../lib/admin.js';
import { prisma } from '../lib/prisma.js';

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthTokenPayload;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;

  if (!token) {
    return res
      .status(401)
      .json({ error: 'Authentication required. Please sign in to continue.' });
  }

  try {
    req.user = verifyToken(token);
  } catch {
    return res
      .status(401)
      .json({ error: 'Your session has expired. Please sign in again.' });
  }
  touchLastSeen(Number(req.user.sub));
  next();
}

/** "Last active" for the admin page: at most one write per user per 5 min. */
const lastTouched = new Map<number, number>();
function touchLastSeen(userId: number) {
  if (!Number.isFinite(userId)) return;
  const now = Date.now();
  if (now - (lastTouched.get(userId) ?? 0) < 5 * 60_000) return;
  lastTouched.set(userId, now);
  void prisma.user
    .update({ where: { id: userId }, data: { lastSeenAt: new Date(now) } })
    .catch(() => undefined);
}

/** Use after requireAuth. Checks the account's current email in the database. */
export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: Number(req.user?.sub) },
      select: { email: true },
    });
    if (!isAdminEmail(user?.email))
      return res.status(403).json({ error: 'Admins only.' });
    next();
  } catch (error) {
    next(error);
  }
}
