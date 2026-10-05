import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import {
  hashPassword,
  signToken,
  verifyPassword,
  verifyPasswordOrDummy,
} from '../lib/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/asyncRoute.js';

const router = Router();

const nameField = z.string().trim().min(2, 'Please enter your name.').max(80);
const passwordField = z
  .string()
  .min(8, 'Password must be at least 8 characters.')
  .max(128, 'Password must be at most 128 characters.');

const registerSchema = z.object({
  name: nameField,
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  password: passwordField,
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
});

const profileSchema = z.object({ name: nameField });

const passwordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password.'),
  newPassword: passwordField,
});

function toPublicUser(user: {
  id: number;
  email: string;
  name: string;
  plan: string;
  planStatus: string;
  createdAt: Date;
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    plan: user.plan,
    planStatus: user.planStatus,
    createdAt: user.createdAt,
  };
}

function tokenFor(user: { id: number; email: string; name: string }) {
  return signToken({
    sub: String(user.id),
    email: user.email,
    name: user.name,
  });
}

router.post(
  '/register',
  asyncRoute(async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: parsed.error.issues[0]?.message ?? 'Invalid sign-up details.',
      });
    }

    const { name, email, password } = parsed.data;

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res
        .status(409)
        .json({ error: 'An account with this email already exists.' });
    }

    const user = await prisma.user.create({
      data: { name, email, passwordHash: await hashPassword(password) },
    });

    res.status(201).json({ user: toPublicUser(user), token: tokenFor(user) });
  })
);

router.post(
  '/login',
  asyncRoute(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: parsed.error.issues[0]?.message ?? 'Invalid sign-in details.',
      });
    }

    const { email, password } = parsed.data;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!(await verifyPasswordOrDummy(password, user?.passwordHash)) || !user) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    res.json({ user: toPublicUser(user), token: tokenFor(user) });
  })
);

router.post('/logout', (_req, res) => {
  // Stateless JWT auth — the client discards its token. This endpoint exists so the
  // frontend has a single consistent place to invalidate any server-side session later.
  res.status(204).end();
});

router.get(
  '/me',
  requireAuth,
  asyncRoute(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: Number(req.user?.sub) },
    });
    if (!user) {
      return res.status(401).json({ error: 'Account no longer exists.' });
    }
    res.json({ user: toPublicUser(user) });
  })
);

router.patch(
  '/me',
  requireAuth,
  asyncRoute(async (req, res) => {
    const parsed = profileSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: parsed.error.issues[0]?.message ?? 'Invalid profile details.',
      });
    }
    const userId = Number(req.user?.sub);
    const existing = await prisma.user.findUnique({ where: { id: userId } });
    if (!existing) {
      return res.status(401).json({ error: 'Account no longer exists.' });
    }
    const user = await prisma.user.update({
      where: { id: userId },
      data: { name: parsed.data.name },
    });
    // The token carries the display name, so hand back a fresh one.
    res.json({ user: toPublicUser(user), token: tokenFor(user) });
  })
);

router.post(
  '/password',
  requireAuth,
  asyncRoute(async (req, res) => {
    const parsed = passwordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: parsed.error.issues[0]?.message ?? 'Invalid password details.',
      });
    }
    const userId = Number(req.user?.sub);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(401).json({ error: 'Account no longer exists.' });
    }
    if (
      !(await verifyPassword(parsed.data.currentPassword, user.passwordHash))
    ) {
      return res
        .status(400)
        .json({ error: 'Your current password is incorrect.' });
    }
    if (parsed.data.currentPassword === parsed.data.newPassword) {
      return res
        .status(400)
        .json({ error: 'Choose a password different from the current one.' });
    }
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(parsed.data.newPassword) },
    });
    res.status(204).end();
  })
);

export default router;
