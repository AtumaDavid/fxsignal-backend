import 'dotenv/config';
import { evaluateExpiredPredictions } from '../src/lib/predictions.js';
import { prisma } from '../src/lib/prisma.js';

/**
 * Re-scores every expired signal with the current settlement rules (candle
 * replay, neutral calls unscored, signed pips). Signals whose window is no
 * longer covered by the provider's candle history are marked "not scored"
 * instead of keeping an outcome judged against a later price.
 *
 * Run once after upgrading from the quote-at-expiry settlement:
 *   npm run db:resettle
 */
async function main() {
  const reset = await prisma.predictionOutcome.updateMany({
    where: { prediction: { expiresAt: { lte: new Date() } } },
    data: {
      status: 'PENDING',
      resolvedPrice: null,
      movementPips: null,
      evaluatedAt: null,
      note: 'Queued for re-settlement.',
    },
  });
  console.log(`Re-settling ${reset.count} expired signals…`);
  await evaluateExpiredPredictions(new Date());
  const summary = await prisma.predictionOutcome.groupBy({
    by: ['status'],
    _count: { _all: true },
  });
  for (const row of summary) console.log(`${row.status}: ${row._count._all}`);
}

main()
  .catch((error) => {
    console.error('Re-settlement failed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
