import type { NextFunction, Request, Response } from 'express';
import { verifyToken, type AuthTokenPayload } from '../lib/auth.js';

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
    next();
  } catch {
    return res
      .status(401)
      .json({ error: 'Your session has expired. Please sign in again.' });
  }
}
