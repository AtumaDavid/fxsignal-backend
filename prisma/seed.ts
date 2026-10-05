import 'dotenv/config';
import { bootstrapDatabase } from '../src/lib/bootstrap.js';
import { hashPassword } from '../src/lib/auth.js';
import { prisma } from '../src/lib/prisma.js';

async function seedDemoUser() {
  const email = 'demo@fxsignal.dev';
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return;
  await prisma.user.create({
    data: {
      name: 'Demo Trader',
      email,
      passwordHash: await hashPassword('fxsignal123'),
      plan: 'PRO',
    },
  });
  console.log('Demo account ready: demo@fxsignal.dev / fxsignal123');
}

bootstrapDatabase()
  .then(seedDemoUser)
  .then(async () => {
    console.log('FXSignal Prisma seed complete.');
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error('FXSignal Prisma seed failed:', error);
    await prisma.$disconnect();
    process.exitCode = 1;
  });
