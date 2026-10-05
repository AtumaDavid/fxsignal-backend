import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/**
 * Shared cache + credit budget for the market-data providers.
 *
 * Three properties matter for staying inside a small provider quota:
 *
 * 1. **Restart-safe.** Entries are mirrored to a JSON file, so a `tsx watch`
 *    reload (or a container restart) reuses the 6-hour snapshot instead of
 *    re-buying it. An in-memory Map alone made the 6h TTL behave like
 *    "until the next code save".
 * 2. **Single-flight.** Concurrent callers for the same key share one request.
 *    Two overlapping refresh triggers used to each miss the empty cache and
 *    each fire a full round of provider calls.
 * 3. **Failure backoff.** A failed load is remembered too, so an error (such as
 *    a 429) cannot turn into a retry storm that spends more credits.
 *
 * `withCredits` then caps how many provider credits may be spent in any rolling
 * 60 seconds, so even a cold start cannot burst past the plan's per-minute cap.
 */

const CACHE_FILE = process.env.MARKET_CACHE_FILE
  ? resolve(process.env.MARKET_CACHE_FILE)
  : resolve(process.cwd(), '.cache', 'market-cache.json');

/** How long a failed load suppresses further attempts for the same key. */
const FAILURE_BACKOFF_MS = 5 * 60_000;

interface CacheEntry {
  value?: unknown;
  hasValue: boolean;
  expiresAt: number;
  failedUntil?: number;
}

let store: Map<string, CacheEntry> | null = null;
let storeLoad: Promise<Map<string, CacheEntry>> | null = null;
const inFlight = new Map<string, Promise<unknown>>();

async function loadStore(): Promise<Map<string, CacheEntry>> {
  if (store) return store;
  if (!storeLoad) {
    storeLoad = (async () => {
      try {
        const raw = await readFile(CACHE_FILE, 'utf8');
        const parsed = JSON.parse(raw) as Record<string, CacheEntry>;
        store = new Map(Object.entries(parsed));
      } catch {
        // No cache file yet (or it is unreadable) — start empty.
        store = new Map();
      }
      return store;
    })();
  }
  return storeLoad;
}

let persisting: Promise<void> = Promise.resolve();

function persist() {
  // Write-behind and best-effort: the cache is an optimization, never a
  // correctness dependency, so a filesystem problem must not break a request.
  persisting = persisting.then(async () => {
    if (!store) return;
    const snapshot = Object.fromEntries(store);
    try {
      await mkdir(dirname(CACHE_FILE), { recursive: true });
      const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(snapshot), 'utf8');
      await rename(tmp, CACHE_FILE);
    } catch (error) {
      console.warn(
        'Unable to persist the market-data cache.',
        error instanceof Error ? error.message : error
      );
    }
  });
}

export interface CacheOptions<T> {
  /** How long a successful value stays fresh. */
  ttlMs: number;
  /** Rehydrates a value read back from disk (JSON has no Date instances). */
  revive?: (raw: unknown) => T;
  /**
   * When the provider fails, return the previous (stale) value instead of
   * throwing. Use for context data where slightly old is fine; leave off where
   * a stale value would be wrong (for example settling an expired signal).
   */
  serveStaleOnError?: boolean;
}

/**
 * Returns the cached value for `key`, calling `loader` only when nothing fresh
 * is stored and no identical load is already running.
 */
export async function cached<T>(
  key: string,
  loader: () => Promise<T>,
  options: CacheOptions<T>
): Promise<T> {
  const map = await loadStore();
  const hydrate = (raw: unknown) =>
    options.revive ? options.revive(raw) : (raw as T);

  const entry = map.get(key);
  const now = Date.now();
  if (entry?.hasValue && now < entry.expiresAt) return hydrate(entry.value);

  const pending = inFlight.get(key);
  if (pending) return (await pending) as T;

  if (entry?.failedUntil && now < entry.failedUntil) {
    if (entry.hasValue && options.serveStaleOnError)
      return hydrate(entry.value);
    throw new Error(
      `${key} is unavailable: the provider failed recently, backing off until ${new Date(
        entry.failedUntil
      ).toISOString()}.`
    );
  }

  const task = (async () => {
    try {
      const value = await loader();
      map.set(key, {
        value,
        hasValue: true,
        expiresAt: Date.now() + options.ttlMs,
      });
      persist();
      return value;
    } catch (error) {
      const previous = map.get(key);
      map.set(key, {
        value: previous?.value,
        hasValue: Boolean(previous?.hasValue),
        expiresAt: previous?.expiresAt ?? 0,
        failedUntil: Date.now() + FAILURE_BACKOFF_MS,
      });
      persist();
      if (previous?.hasValue && options.serveStaleOnError) {
        console.warn(
          `${key} refresh failed; serving the cached value.`,
          error instanceof Error ? error.message : error
        );
        return hydrate(previous.value);
      }
      throw error;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, task);
  return task;
}

/**
 * Read-only peek: returns the cached value for `key` only when a fresh entry
 * is already stored, otherwise `null` — never calls the provider. Used by web
 * refresh paths (ticker prices) that must stay free of provider calls.
 */
export async function peek<T>(key: string): Promise<T | null> {
  const map = await loadStore();
  const entry = map.get(key);
  if (!entry?.hasValue || Date.now() >= entry.expiresAt) return null;
  return entry.value as T;
}

/**
 * Like `peek`, but also returns an expired value. For display-only reads such
 * as the ticker, where the last known price (with its own timestamp) beats
 * showing nothing. Never calls the provider.
 */
export async function peekStale<T>(key: string): Promise<T | null> {
  const map = await loadStore();
  const entry = map.get(key);
  return entry?.hasValue ? (entry.value as T) : null;
}

// ---- Provider credit budget -----------------------------------------------
// Twelve Data bills one credit per request. The plan allows 8 credits/minute;
// the default budget leaves headroom so an unrelated manual call cannot tip the
// account over the limit.
const CREDIT_LIMIT = Math.max(
  1,
  Number(process.env.TWELVE_DATA_CREDITS_PER_MINUTE ?? 6)
);
const CREDIT_WINDOW_MS = 60_000;

let spentCredits: number[] = [];
/** Serializes reservations so concurrent callers cannot both pass the check. */
let creditGate: Promise<void> = Promise.resolve();

function sleep(ms: number) {
  return new Promise((done) => setTimeout(done, ms));
}

async function reserveCredits(cost: number) {
  const reservation = creditGate.then(async () => {
    for (;;) {
      const now = Date.now();
      spentCredits = spentCredits.filter(
        (stamp) => now - stamp < CREDIT_WINDOW_MS
      );
      if (spentCredits.length + cost <= CREDIT_LIMIT) {
        for (let index = 0; index < cost; index += 1) spentCredits.push(now);
        return;
      }
      await sleep(CREDIT_WINDOW_MS - (now - spentCredits[0]) + 50);
    }
  });
  creditGate = reservation.then(
    () => undefined,
    () => undefined
  );
  return reservation;
}

/**
 * Runs `request` once enough credits are available in the rolling minute,
 * waiting rather than bursting past the plan's per-minute cap.
 */
export async function withCredits<T>(
  cost: number,
  request: () => Promise<T>
): Promise<T> {
  await reserveCredits(cost);
  return request();
}
