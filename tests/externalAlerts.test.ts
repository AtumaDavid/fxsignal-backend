import { describe, expect, it } from 'vitest';
import { isPrivateAddress, signBody, urlProblem } from '../src/lib/externalAlerts.js';

describe('external alert destinations', () => {
  it('only allows public https URLs', () => {
    expect(urlProblem('https://example.com/hook', 'webhook')).toBeNull();
    expect(urlProblem('http://example.com/hook', 'webhook')).toMatch(/https/);
    expect(urlProblem('https://127.0.0.1/hook', 'webhook')).toMatch(/IP address/);
    expect(urlProblem('https://localhost/hook', 'webhook')).toMatch(/local/);
    expect(urlProblem('https://user:pw@example.com/', 'webhook')).toMatch(/credentials/);
    expect(urlProblem('https://example.com:8443/', 'webhook')).toMatch(/port/);
  });

  it('accepts only Discord webhook URLs for Discord', () => {
    expect(urlProblem('https://discord.com/api/webhooks/1/abc', 'discord')).toBeNull();
    expect(urlProblem('https://example.com/api/webhooks/1/abc', 'discord')).toMatch(/Discord/);
  });

  it('recognises private and reserved addresses', () => {
    for (const a of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.5.4', '192.168.1.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1'])
      expect(isPrivateAddress(a)).toBe(true);
    for (const a of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111'])
      expect(isPrivateAddress(a)).toBe(false);
  });

  it('signs webhook bodies with HMAC-SHA256', () => {
    expect(signBody('secret', '{"a":1}')).toMatch(/^[0-9a-f]{64}$/);
    expect(signBody('secret', '{"a":1}')).not.toBe(signBody('other', '{"a":1}'));
  });
});
