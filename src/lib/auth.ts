import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const DEV_SECRET = 'fxsignal-dev-secret-change-me';
const JWT_EXPIRES_IN = '7d';

function resolveSecret(): string {
  const secret = process.env.JWT_SECRET?.trim();
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') {
    // A guessable signing key lets anyone mint tokens for any account.
    throw new Error('JWT_SECRET must be set in production.');
  }
  console.warn('JWT_SECRET is not set; using the insecure development secret.');
  return DEV_SECRET;
}

const JWT_SECRET = resolveSecret();

export interface AuthTokenPayload {
  sub: string;
  email: string;
  name: string;
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// Compared against when the email is unknown, so a failed login costs the same
// bcrypt time whether or not the account exists (no email enumeration by timing).
const DUMMY_HASH = bcrypt.hashSync('fxsignal-timing-guard', 12);

export async function verifyPasswordOrDummy(
  password: string,
  hash: string | null | undefined
): Promise<boolean> {
  const ok = await bcrypt.compare(password, hash ?? DUMMY_HASH);
  return Boolean(hash) && ok;
}

export function signToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function verifyToken(token: string): AuthTokenPayload {
  return jwt.verify(token, JWT_SECRET) as AuthTokenPayload;
}
