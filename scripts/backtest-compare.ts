/**
 * Compares engine variants on the same history, one change at a time.
 *
 *   npm run backtest:compare                 # development period only
 *   npm run backtest:compare -- --holdout    # the locked holdout, once, at the end
 *
 * History: MONTHS (default 24) months up to TO (default: today 00:00 UTC),
 * downloaded once and cached in .cache/history (≈16 provider credits per pair
 * the first time). The oldest HOLDOUT_MONTHS (default 6) are the holdout:
 * never looked at while choosing rules. The rest is the development period,
 * reported as a whole and in WALK_FOLD_MONTHS (default 3) walk-forward folds —
 * the rules have no fitted parameters, so the folds show whether a result
 * holds across market regimes rather than in one lucky stretch.
 *
 * Every variant pays spread + slippage (risk.ts). With HISTORY_SOURCE=oanda
 * (and OANDA_API_TOKEN from a free practice account) the history is bid/ask,
 * and each trade pays the real spread at its fill plus slippage instead of
 * the fixed estimate. News comes from the local calendar table when the
 * database is reachable.
 */
import 'dotenv/config';
import {
  loadHistories,
  simulatePortfolio,
  summarize,
  type BacktestTrade,
  type PortfolioRules,
} from '../src/lib/backtest.js';
import { prisma } from '../src/lib/prisma.js';
import type { LiveMarketEvent } from '../src/lib/liveData.js';

const months = Number(process.env.MONTHS ?? 24);
const holdoutMonths = Number(process.env.HOLDOUT_MONTHS ?? 6);
const foldMonths = Number(process.env.WALK_FOLD_MONTHS ?? 3);
const showHoldout = process.argv.includes('--holdout');
const source = process.env.HISTORY_SOURCE === 'oanda' ? 'oanda' : 'twelvedata';

const to = process.env.TO ? new Date(process.env.TO) : new Date();
to.setUTCHours(0, 0, 0, 0);
const from = new Date(to);
from.setUTCMonth(from.getUTCMonth() - months);
const devFrom = new Date(from);
devFrom.setUTCMonth(devFrom.getUTCMonth() + holdoutMonths);

type Engine = Parameters<typeof simulatePortfolio>[4];
const VARIANTS: { name: string; engine: Engine; rules?: PortfolioRules; news?: boolean }[] = [
  { name: 'ATR zone, fill on touch (old)', engine: { levelModel: 'atr', entryTrigger: 'TOUCH' } },
  { name: 'ATR zone, M15-close trigger (live)', engine: { levelModel: 'atr', entryTrigger: 'M15_CLOSE' } },
  { name: 'Zones: S/R levels + pivots', engine: { levelModel: 'zones', zoneSources: { demandSupply: false, orderBlocks: false } } },
  { name: 'Zones: + demand/supply', engine: { levelModel: 'zones', zoneSources: { orderBlocks: false } } },
  { name: 'Zones: + H1 order blocks', engine: { levelModel: 'zones' } },
  {
    name: 'Live, without news/portfolio rules',
    engine: { levelModel: 'atr', entryTrigger: 'M15_CLOSE' },
    rules: { usdCap: false, dailyLossLimit: false },
    news: false,
  },
];

async function storedEvents(): Promise<LiveMarketEvent[]> {
  try {
    const rows = await prisma.marketEvent.findMany({
      where: { eventDate: { gte: from, lte: to } },
    });
    return rows.map((e) => ({
      externalId: e.externalId,
      currency: e.currency,
      title: e.title,
      eventDate: e.eventDate,
      impact: e.impact,
      forecast: e.forecast,
      previousValue: e.previousValue,
    })) as LiveMarketEvent[];
  } catch {
    console.warn('Calendar table unreachable — running without news.');
    return [];
  }
}

function folds(start: Date, end: Date) {
  const out: [Date, Date][] = [];
  const cur = new Date(start);
  while (cur < end) {
    const next = new Date(cur);
    next.setUTCMonth(next.getUTCMonth() + foldMonths);
    out.push([new Date(cur), next < end ? next : new Date(end)]);
    cur.setTime(next.getTime());
  }
  return out;
}

const fmt = (n: number | null | undefined, d = 2) =>
  n === null || n === undefined ? '—' : (n > 0 ? '+' : '') + n.toFixed(d);

async function main() {
  console.log(
    `History ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}; ` +
      `holdout ${from.toISOString().slice(0, 10)} → ${devFrom.toISOString().slice(0, 10)}` +
      (showHoldout ? ' (REPORTED — use once)' : ' (locked)')
  );
  const histories = await loadHistories(from, to, source);
  console.log(`History source: ${source === 'oanda' ? 'OANDA bid/ask (real spreads)' : 'Twelve Data (fixed cost estimate)'}`);
  const events = await storedEvents();
  console.log(`${events.filter((e) => e.impact === 'HIGH').length} high-impact events in range.\n`);

  const [rangeFrom, rangeTo] = showHoldout ? [from, devFrom] : [devFrom, to];
  const foldList = showHoldout ? [] : folds(rangeFrom, rangeTo);

  for (const v of VARIANTS) {
    const run = simulatePortfolio(histories, v.news === false ? [] : events, rangeFrom, rangeTo, v.engine, v.rules);
    const s = summarize(run.trades, rangeFrom, rangeTo, run);
    const mc = s.monteCarlo;
    console.log(`■ ${v.name}`);
    console.log(
      `  ${s.trades} trades · net ${fmt(s.netR)}R · ${fmt(s.avgR)}R/trade · PF ${s.profitFactor ?? '—'} · ` +
        `maxDD ${s.maxDrawdownR}R · not triggered ${s.notTriggered} · blocked ${s.portfolioBlocked} · ` +
        `cost ${Object.entries(s.costPips).map(([p, c]) => `${p} ${c}p`).join(', ')}`
    );
    if (mc)
      console.log(
        `  Monte Carlo: net 90% ${fmt(mc.netR.p5)}…${fmt(mc.netR.p95)}R, P(profit) ${Math.round(mc.probProfit * 100)}%, ` +
          `maxDD p95 ${mc.maxDrawdownR.p95}R, losing run p95 ${mc.longestLosingStreak.p95}`
      );
    if (foldList.length > 0) {
      const cells = foldList.map(([a, b]) => {
        const inFold = run.trades.filter(
          (t: BacktestTrade) => t.publishedAt >= a.toISOString() && t.publishedAt < b.toISOString()
        );
        const f = summarize(inFold, a, b, { standAsides: 0, skippedOpen: 0 });
        return `${a.toISOString().slice(0, 7)} ${f.trades}t ${fmt(f.netR, 1)}R`;
      });
      console.log(`  Folds: ${cells.join(' | ')}`);
    }
    console.log('');
  }
  await prisma.$disconnect().catch(() => undefined);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
