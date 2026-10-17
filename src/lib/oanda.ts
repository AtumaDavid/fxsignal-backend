import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { PairCode } from './model.js';
import type { Candle, Timeframe } from './technical.js';

// ---- OANDA bid/ask history (backtest only) -------------------------------------
//
// A free OANDA practice (demo) account gives an API token with historical
// bid/ask candles. They replace Twelve Data's single-price candles in the
// backtest so each trade pays the spread that was really there at its fill.
//
//   OANDA_API_TOKEN=...            (practice account → Manage API Access)
//   OANDA_API_URL=https://api-fxpractice.oanda.com   (default)

const GRANULARITY: Partial<Record<Timeframe, string>> = {
  DAILY: 'D',
  H4: 'H4',
  H1: 'H1',
  M15: 'M15',
};
const PAGE = 5000;
const HISTORY_DIR = resolve(process.cwd(), '.cache', 'history');

export function oandaConfigured() {
  return Boolean(process.env.OANDA_API_TOKEN);
}

interface OandaCandle {
  time: string;
  complete: boolean;
  bid?: { o: string; h: string; l: string; c: string };
  ask?: { o: string; h: string; l: string; c: string };
}

/** "2026-10-06T08:15:00.000000000Z" → the app's "2026-10-06 08:15:00" ("2026-10-06" for daily). */
function datetimeOf(time: string, daily: boolean) {
  const iso = new Date(time).toISOString();
  return daily ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ');
}

/** Mid OHLC from bid/ask, with the closing spread (price units) kept on the candle. */
export function toMidCandle(c: OandaCandle, daily: boolean): Candle | null {
  if (!c.bid || !c.ask || !c.complete) return null;
  const mid = (a: string, b: string) => (Number(a) + Number(b)) / 2;
  const candle: Candle = {
    datetime: datetimeOf(c.time, daily),
    open: mid(c.bid.o, c.ask.o),
    high: mid(c.bid.h, c.ask.h),
    low: mid(c.bid.l, c.ask.l),
    close: mid(c.bid.c, c.ask.c),
    spread: Number(c.ask.c) - Number(c.bid.c),
  };
  return [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)
    ? candle
    : null;
}

type Fetcher = (url: string, init: { headers: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

/**
 * Oldest-first bid/ask-derived candles for [from, to], paged 5,000 at a time
 * and cached on disk. Daily and H4 are aligned to 00:00 UTC to match the
 * live engine's Twelve Data candles.
 */
export async function fetchOandaHistory(
  pair: PairCode,
  tf: Timeframe,
  from: Date,
  to: Date,
  options: { fetcher?: Fetcher; cache?: boolean } = {}
): Promise<Candle[]> {
  const fetcher = options.fetcher ?? (fetch as unknown as Fetcher);
  const cache = options.cache ?? true;
  const token = process.env.OANDA_API_TOKEN;
  if (!token) throw new Error('OANDA_API_TOKEN is not configured.');
  const granularity = GRANULARITY[tf];
  if (!granularity) throw new Error(`No OANDA granularity for ${tf}.`);
  const file = resolve(
    HISTORY_DIR,
    `oanda-${pair.replace('/', '')}-${tf}-${from.toISOString().slice(0, 10)}-${to.toISOString().slice(0, 10)}.json`
  );
  if (cache) {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as Candle[];
    } catch {
      // Not downloaded yet.
    }
  }
  const base = (process.env.OANDA_API_URL ?? 'https://api-fxpractice.oanda.com').replace(/\/+$/, '');
  const instrument = pair.replace('/', '_');
  const daily = tf === 'DAILY';
  const out: Candle[] = [];
  let cursor = from;
  for (let page = 0; page < 40 && cursor < to; page += 1) {
    const query = new URLSearchParams({
      price: 'BA',
      granularity,
      from: cursor.toISOString(),
      count: String(PAGE),
      dailyAlignment: '0',
      alignmentTimezone: 'UTC',
      includeFirst: page === 0 ? 'true' : 'false',
    });
    const response = await fetcher(
      `${base}/v3/instruments/${instrument}/candles?${query.toString()}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const body = (await response.json()) as { candles?: OandaCandle[]; errorMessage?: string };
    if (!response.ok)
      throw new Error(`OANDA ${response.status}: ${body.errorMessage ?? 'request failed'}`);
    const candles = body.candles ?? [];
    if (candles.length === 0) break;
    for (const c of candles) {
      if (new Date(c.time) > to) break;
      const candle = toMidCandle(c, daily);
      if (candle) out.push(candle);
    }
    const last = new Date(candles[candles.length - 1].time);
    if (candles.length < PAGE || last >= to) break;
    cursor = last;
  }
  if (cache) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(out), 'utf8');
  }
  return out;
}
