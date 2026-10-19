/**
 * Exit research (spec, section 8): MAE/MFE of the live model's trades and how
 * alternative exits would have done on exactly the same entries.
 *
 *   TO=2026-10-17 npm run backtest:exits             # development period
 *   TO=2026-10-17 npm run backtest:exits -- --holdout
 *
 * Same history, period split and costs as backtest:compare. Entries come from
 * the live engine (same filters, scans and portfolio rules); each filled trade
 * is then replayed from its real fill to the Friday hold limit under every
 * exit rule. Limits: the H1 checkpoint's early exits are ignored, and the
 * entry list is held fixed (a different exit would change which later trades
 * the portfolio rules allow).
 */
import 'dotenv/config';
import {
  loadHistories,
  simulatePortfolio,
  type BacktestTrade,
} from '../src/lib/backtest.js';
import { candleTime } from '../src/lib/liveData.js';
import { exitResult, excursion, type ExitRule } from '../src/lib/exits.js';
import { pipSize } from '../src/lib/market.js';
import { tradingWindowAt } from '../src/lib/market.js';
import { tradeHoldUntil } from '../src/lib/predictions.js';
import { monteCarlo } from '../src/lib/risk.js';
import type { PairCode } from '../src/lib/model.js';

const months = Number(process.env.MONTHS ?? 24);
const holdoutMonths = Number(process.env.HOLDOUT_MONTHS ?? 6);
const showHoldout = process.argv.includes('--holdout');
const to = process.env.TO ? new Date(process.env.TO) : new Date();
to.setUTCHours(0, 0, 0, 0);
const from = new Date(to);
from.setUTCMonth(from.getUTCMonth() - months);
const devFrom = new Date(from);
devFrom.setUTCMonth(devFrom.getUTCMonth() + holdoutMonths);
const [rangeFrom, rangeTo] = showHoldout ? [from, devFrom] : [devFrom, to];

const RULES: { name: string; rule: ExitRule | 'regime' }[] = [
  { name: 'Fixed 1R', rule: { kind: 'fixed', targetR: 1 } },
  { name: 'Fixed 1.5R', rule: { kind: 'fixed', targetR: 1.5 } },
  { name: 'Fixed 2R', rule: { kind: 'fixed', targetR: 2 } },
  { name: 'Fixed 3R', rule: { kind: 'fixed', targetR: 3 } },
  { name: '2R, stop to entry at +1R', rule: { kind: 'breakeven', targetR: 2, afterR: 1 } },
  { name: 'Thirds at 1/2/3R, trailing (live)', rule: { kind: 'thirds' } },
  { name: '2R, close at window end', rule: { kind: 'windowEnd', targetR: 2 } },
  { name: '2R, close after 8 hours', rule: { kind: 'hours', targetR: 2, hours: 8 } },
  { name: 'Regime: 3R trending, 1.5R otherwise', rule: 'regime' },
];

const r2 = (x: number) => Number(x.toFixed(2));
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '—');

async function main() {
  const histories = await loadHistories(from, to);
  const run = simulatePortfolio(
    histories,
    [],
    rangeFrom,
    rangeTo,
    { levelModel: 'atr', entryTrigger: 'M15_CLOSE' },
    { scans: 'rearm' }
  );
  const filled = run.trades.filter(
    (t): t is BacktestTrade & { fillPrice: number; filledAt: string } =>
      t.filled && t.fillPrice != null && t.filledAt != null
  );
  console.log(
    `${showHoldout ? 'HOLDOUT' : 'Development'} ${rangeFrom.toISOString().slice(0, 10)} → ${rangeTo.toISOString().slice(0, 10)}: ${filled.length} filled trades (live entries)\n`
  );

  const paths = filled.map((t) => {
    const m15 = histories[t.pairCode as PairCode]?.M15 ?? [];
    const fillAt = Date.parse(t.filledAt);
    const until = tradeHoldUntil(new Date(t.publishedAt)).getTime();
    return {
      trade: t,
      path: {
        direction: t.direction,
        fill: t.fillPrice,
        stop: t.stop,
        // The confirming candle filled at its close: the path starts after it.
        candles: m15.filter((c) => candleTime(c) > fillAt && candleTime(c) < until),
        windowEnd: tradingWindowAt(new Date(t.publishedAt))?.end.getTime() ?? until,
      },
    };
  });

  // ---- MAE / MFE ------------------------------------------------------------
  const ex = paths
    .map((p) => ({ ...p, e: excursion(p.path) }))
    .filter((p): p is typeof p & { e: NonNullable<typeof p.e> } => p.e !== null);
  const stopped = ex.filter((p) => p.e.stopped);
  console.log('MFE: share of trades that reached each level before their stop');
  console.log(
    '  ' +
      [0.5, 1, 1.5, 2, 3]
        .map((r) => `${r}R ${pct(ex.filter((p) => p.e.mfeR >= r).length, ex.length)}`)
        .join(' · ')
  );
  console.log(
    `  Stopped out: ${pct(stopped.length, ex.length)}; of those, reached +1R first: ${pct(
      stopped.filter((p) => p.e.mfeR >= 1).length,
      stopped.length
    )}, +0.5R first: ${pct(stopped.filter((p) => p.e.mfeR >= 0.5).length, stopped.length)}`
  );
  const winners = ex.filter((p) => p.e.mfeR >= 2);
  const maes = winners.map((p) => p.e.maeR).sort((a, b) => a - b);
  if (maes.length)
    console.log(
      `  Trades that reached 2R: median MAE ${r2(maes[Math.floor(maes.length / 2)])}R, 80th percentile ${r2(maes[Math.floor(maes.length * 0.8)])}R (how close they came to the stop first)\n`
    );

  // ---- Exit variants ----------------------------------------------------------
  for (const { name, rule } of RULES) {
    const results = paths.flatMap(({ trade, path }) => {
      const chosen: ExitRule =
        rule === 'regime'
          ? { kind: 'fixed', targetR: trade.features?.trend === 'TRENDING' ? 3 : 1.5 }
          : rule;
      const gross = exitResult(path, chosen);
      if (gross === null) return [];
      const riskPips = Math.abs(path.fill - path.stop) / pipSize(trade.pairCode);
      return [{ trade, r: gross - trade.costPips / riskPips }];
    });
    const rs = results.map((x) => x.r);
    const net = rs.reduce((a, b) => a + b, 0);
    const gains = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
    const losses = -rs.filter((r) => r < 0).reduce((a, b) => a + b, 0);
    const mc = monteCarlo(rs);
    const halves = [0, 1].map((h) => {
      const mid = rangeFrom.getTime() + (rangeTo.getTime() - rangeFrom.getTime()) / 2;
      const part = results.filter((x) =>
        h === 0 ? Date.parse(x.trade.publishedAt) < mid : Date.parse(x.trade.publishedAt) >= mid
      );
      return r2(part.reduce((a, b) => a + b.r, 0));
    });
    console.log(
      `■ ${name}: ${rs.length} trades · ${r2(net / rs.length)}R/trade · net ${r2(net)}R · PF ${losses ? r2(gains / losses) : '—'} · ` +
        `wins ${pct(rs.filter((r) => r > 0).length, rs.length)} · halves ${halves.join(' / ')}R` +
        (mc ? ` · P(profit) ${Math.round(mc.probProfit * 100)}%` : '')
    );
  }
  console.log('\nAll results after the same spread + slippage as the backtest. Research only: no exit rule changes live until it is positive out of sample.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
