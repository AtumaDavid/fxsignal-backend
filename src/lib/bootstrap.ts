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
