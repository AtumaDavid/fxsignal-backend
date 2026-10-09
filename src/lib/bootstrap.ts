import 'dotenv/config';
import { prisma } from './prisma.js';

const pairs = [
  {
    code: 'EUR/USD',
    displayName: 'Euro / US Dollar',
    baseCurrency: 'EUR',
    quoteCurrency: 'USD',
    pipSize: 0.0001,
  },
  {
    code: 'USD/JPY',
    displayName: 'US Dollar / Japanese Yen',
    baseCurrency: 'USD',
    quoteCurrency: 'JPY',
    pipSize: 0.01,
  },
] as const;

export async function bootstrapDatabase() {
  await prisma.$connect();

  // Additive, idempotent column migrations, so a deploy that runs before
  // `prisma db push` cannot take the API down with "column does not exist".
  // Each statement is independent and tolerant: on a brand-new database the
  // tables do not exist yet (db:init creates them), which is fine.
  for (const sql of [
    'ALTER TABLE "Prediction" ADD COLUMN IF NOT EXISTS "continuesId" INTEGER',
    `ALTER TYPE "OutcomeStatus" ADD VALUE IF NOT EXISTS 'CANCELLED'`,
    `ALTER TYPE "OutcomeStatus" ADD VALUE IF NOT EXISTS 'CLOSED_EARLY'`,
    // TP1 / TP2 + breakeven management.
    `ALTER TYPE "OutcomeStatus" ADD VALUE IF NOT EXISTS 'BREAKEVEN'`,
    'ALTER TABLE "Prediction" ADD COLUMN IF NOT EXISTS "target2Price" DECIMAL(16,6)',
    // Alerts + automatic journal exits. Same DDL `prisma db push` generates.
    'ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "alertPrefs" JSONB',
    'ALTER TABLE "UserTrade" ADD COLUMN IF NOT EXISTS "stopPrice" DECIMAL(16,6)',
    'ALTER TABLE "UserTrade" ADD COLUMN IF NOT EXISTS "targetPrice" DECIMAL(16,6)',
    'ALTER TABLE "UserTrade" ADD COLUMN IF NOT EXISTS "exitedAt" TIMESTAMP(3)',
    'ALTER TABLE "UserTrade" ADD COLUMN IF NOT EXISTS "exitReason" TEXT',
    `CREATE TABLE IF NOT EXISTS "Notification" (
      "id" SERIAL NOT NULL,
      "userId" INTEGER NOT NULL,
      "kind" TEXT NOT NULL,
      "title" TEXT NOT NULL,
      "body" TEXT NOT NULL,
      "predictionId" INTEGER,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "readAt" TIMESTAMP(3),
      CONSTRAINT "Notification_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
    )`,
    'CREATE INDEX IF NOT EXISTS "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt")',
    `CREATE TABLE IF NOT EXISTS "PushSubscription" (
      "id" SERIAL NOT NULL,
      "userId" INTEGER NOT NULL,
      "endpoint" TEXT NOT NULL,
      "p256dh" TEXT NOT NULL,
      "auth" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
    )`,
    'CREATE UNIQUE INDEX IF NOT EXISTS "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint")',
    'CREATE INDEX IF NOT EXISTS "PushSubscription_userId_idx" ON "PushSubscription"("userId")',
    `CREATE TABLE IF NOT EXISTS "SignalEvent" (
      "id" SERIAL NOT NULL,
      "predictionId" INTEGER NOT NULL,
      "kind" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "SignalEvent_pkey" PRIMARY KEY ("id")
    )`,
    'CREATE UNIQUE INDEX IF NOT EXISTS "SignalEvent_predictionId_kind_key" ON "SignalEvent"("predictionId", "kind")',
  ]) {
    await prisma
      .$executeRawUnsafe(sql)
      .catch((error: unknown) =>
        console.warn(
          `Schema patch skipped (${sql.split(' ').slice(0, 3).join(' ')}…):`,
          error instanceof Error ? error.message.split('\n')[0] : error
        )
      );
  }

  // Static reference data only — no market content is seeded. Predictions,
  // outcomes and calendar events are produced exclusively by the live
  // providers (Twelve Data, Trading Economics, DeepSeek) when configured.
  for (const pair of pairs) {
    await prisma.currencyPair.upsert({
      where: { code: pair.code },
      update: { displayName: pair.displayName, isActive: true },
      create: pair,
    });
  }
}

if (process.argv[1]?.endsWith('/bootstrap.ts')) {
  bootstrapDatabase()
    .then(async () => {
      console.log('FXSignal database is ready.');
      await prisma.$disconnect();
    })
    .catch(async (error) => {
      console.error('Database initialization failed:', error);
      await prisma.$disconnect();
      process.exitCode = 1;
    });
}
