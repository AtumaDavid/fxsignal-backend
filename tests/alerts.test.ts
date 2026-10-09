import { describe, expect, it } from 'vitest';
import { composeAlert, type AlertKind } from '../src/lib/alerts.js';
import { prediction } from './helpers.js';

const KINDS: AlertKind[] = [
  'SIGNAL_NEW',
  'ENTRY_FILLED',
  'TP1_HIT',
  'TP2_HIT',
  'TP3_HIT',
  'TARGET_HIT',
  'STOP_HIT',
  'TRAIL_STOP_HIT',
  'CANCELLED',
  'CLOSED_EARLY',
];

describe('alert copy', () => {
  it('has a title and body naming the pair for every kind', () => {
    for (const kind of KINDS) {
      const { title, body } = composeAlert(kind, prediction(), {
        pips: 12.5,
        note: 'Cancelled before entry: H1 turned against the context.',
        price: 1.1,
      });
      expect(title, kind).toContain('EUR/USD');
      expect(body.length, kind).toBeGreaterThan(5);
    }
  });

  it('tells the trader what to do at each target', () => {
    const p = prediction();
    expect(composeAlert('TP1_HIT', p, {}).body).toMatch(/stop to your entry/);
    expect(composeAlert('TP2_HIT', p, {}).body).toMatch(/stop to TP1/);
    expect(composeAlert('TP3_HIT', p, {}).body).toMatch(/last third/);
  });

  it('lists all three targets on a new signal', () => {
    const { body } = composeAlert('SIGNAL_NEW', prediction(), {});
    expect(body).toMatch(/TP1 1\.10250, TP2 1\.10450, TP3 1\.10650/);
  });
});
