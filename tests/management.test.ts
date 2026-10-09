import { describe, expect, it } from 'vitest';
import {
  decideOnH1Close,
  newsForSignal,
  openTradeDecision,
} from '../src/lib/predictions.js';
import { prediction } from './helpers.js';

const base = {
  direction: 'LONG' as const,
  entryLow: 1.1,
  entryHigh: 1.101,
  invalidationPrice: 1.0985,
  h4Score: 0,
  contextScore: 30,
};

describe('H1 checkpoint', () => {
  it('cancels before entry when H1 closes beyond the stop', () => {
    const d = decideOnH1Close({ ...base, state: 'waiting', h1Close: 1.098, h1Score: 0 });
    expect(d.action).toBe('cancel');
  });

  it('cancels before entry when the context flips', () => {
    const d = decideOnH1Close({
      ...base,
      state: 'waiting',
      h1Close: 1.1012,
      h1Score: 0,
      contextScore: -20,
    });
    expect(d.action).toBe('cancel');
  });

  it('leaves a healthy waiting setup alone', () => {
    const d = decideOnH1Close({ ...base, state: 'waiting', h1Close: 1.1012, h1Score: 20 });
    expect(d.action).toBe('none');
  });

  it('exits a running trade only on two pieces of evidence', () => {
    const backThroughOnly = decideOnH1Close({
      ...base,
      state: 'running',
      h1Close: 1.0995,
      h1Score: 0,
    });
    expect(backThroughOnly.action).toBe('none');
    const both = decideOnH1Close({
      ...base,
      state: 'running',
      h1Close: 1.0995,
      h1Score: -30,
    });
    expect(both.action).toBe('exit');
  });
});

describe('open trade carry', () => {
  const open = [prediction({ id: '7', direction: 'LONG' })];

  it('carries the open trade when the new read agrees', () => {
    const d = openTradeDecision(prediction({ id: '8' }), open);
    expect(d).toMatchObject({ action: 'carry', reconfirmed: true });
  });

  it('carries, not re-confirmed, when the new read is neutral', () => {
    const d = openTradeDecision(prediction({ id: '8', direction: 'NEUTRAL' }), open);
    expect(d).toMatchObject({ action: 'carry', reconfirmed: false });
  });

  it('publishes an opposite call with a warning', () => {
    const d = openTradeDecision(prediction({ id: '8', direction: 'SHORT' }), open);
    expect(d.action).toBe('publish');
    if (d.action === 'publish')
      expect(d.signal.factors[0]).toMatch(/Conflicts with the open/);
  });

  it('publishes normally when nothing is open on the pair', () => {
    const d = openTradeDecision(prediction({ pairCode: 'USD/JPY' }), open);
    expect(d.action).toBe('publish');
  });
});

describe('news risk', () => {
  const now = new Date('2026-10-06T08:00:00Z');
  const ev = (currency: string, at: string, impact = 'HIGH') => ({
    title: `${currency} CPI`,
    currency,
    eventDate: new Date(at),
    impact,
  });

  it('flags high-impact news for either currency in the window', () => {
    const news = newsForSignal(
      prediction(),
      [
        ev('USD', '2026-10-06T10:30:00Z'),
        ev('EUR', '2026-10-06T09:00:00Z'),
        ev('JPY', '2026-10-06T09:00:00Z'),
        ev('USD', '2026-10-06T09:30:00Z', 'MEDIUM'),
        ev('USD', '2026-10-07T13:30:00Z'),
      ],
      now
    );
    expect(news.map((n) => n.currency)).toEqual(['EUR', 'USD']);
  });

  it('ignores stand-asides', () => {
    expect(
      newsForSignal(prediction({ direction: 'NEUTRAL' }), [ev('USD', '2026-10-06T09:00:00Z')], now)
    ).toEqual([]);
  });
});
