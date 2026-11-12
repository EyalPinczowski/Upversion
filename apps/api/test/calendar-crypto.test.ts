import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CalendarCryptoError,
  CalendarTokenCrypto,
  parseCalendarTokenKeys,
} from '../src/calendar-crypto';
import { ConfigError, loadConfig } from '../src/config';

const k1 = randomBytes(32).toString('base64');
const k2 = randomBytes(32).toString('base64');
const keysOf = (raw: string) => {
  const r = parseCalendarTokenKeys(raw);
  if (r.problems.length > 0) throw new Error('bad test keys');
  return r.keys;
};
const oldOnly = () => new CalendarTokenCrypto(keysOf(`v1:${k1}`));
const rotated = () => new CalendarTokenCrypto(keysOf(`v2:${k2},v1:${k1}`));
const TOKEN = '1//refresh-token-value';

describe('CalendarTokenCrypto', () => {
  it('round trips and uses the keyId.iv.ciphertext.tag format with a fresh IV each time', () => {
    const c = rotated();
    const a = c.encrypt(TOKEN, 'user-1');
    const b = c.encrypt(TOKEN, 'user-1');
    expect(c.decrypt(a, 'user-1')).toBe(TOKEN);
    expect(a).not.toBe(b);
    const parts = a.split('.');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v2');
    expect(parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))).toBe(true);
    expect(Buffer.from(parts[1]!, 'base64url')).toHaveLength(12);
    expect(a).not.toContain(TOKEN);
  });

  it('rejects tampered ciphertext, tag, iv and key id', () => {
    const c = rotated();
    const [id, iv, ct, tag] = c.encrypt(TOKEN, 'user-1').split('.') as [
      string,
      string,
      string,
      string,
    ];
    const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    for (const bad of [
      [id, iv, flip(ct), tag],
      [id, iv, ct, flip(tag)],
      [id, flip(iv), ct, tag],
      ['v1', iv, ct, tag],
      [id, iv, ct],
    ]) {
      expect(() => c.decrypt(bad.join('.'), 'user-1')).toThrow(CalendarCryptoError);
    }
    expect(() => c.decrypt('', 'user-1')).toThrow(CalendarCryptoError);
  });

  it('refuses to encrypt an empty token', () => {
    expect(() => rotated().encrypt('', 'user-1')).toThrow(CalendarCryptoError);
  });

  it('binds the key id: same key material under two ids, relabelled token fails', () => {
    const c = new CalendarTokenCrypto(keysOf(`a:${k1},b:${k1}`));
    const value = c.encrypt(TOKEN, 'user-1');
    expect(c.decrypt(value, 'user-1')).toBe(TOKEN);
    const [, iv, ct, tag] = value.split('.');
    expect(() => c.decrypt(['b', iv, ct, tag].join('.'), 'user-1')).toThrow(CalendarCryptoError);
  });

  it('fails for a different user id', () => {
    const c = rotated();
    expect(() => c.decrypt(c.encrypt(TOKEN, 'user-1'), 'user-2')).toThrow(CalendarCryptoError);
  });

  it('decrypts with an older key, and needsReencrypt is true only for non-newest keys', () => {
    const legacy = oldOnly().encrypt(TOKEN, 'user-1');
    const c = rotated();
    expect(c.decrypt(legacy, 'user-1')).toBe(TOKEN);
    expect(c.needsReencrypt(legacy)).toBe(true);
    expect(c.needsReencrypt(c.encrypt(TOKEN, 'user-1'))).toBe(false);
    expect(c.needsReencrypt('garbage')).toBe(true);
  });

  it('does not decrypt a key id that is not listed, and errors never echo input', () => {
    const value = rotated().encrypt(TOKEN, 'user-1');
    let message = '';
    try {
      oldOnly().decrypt(value, 'user-1');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe('cannot decrypt token');
    expect(message).not.toContain(TOKEN);
  });

  it('rejects keys of the wrong length', () => {
    expect(() => new CalendarTokenCrypto([{ id: 'v1', key: randomBytes(16) }])).toThrow(
      CalendarCryptoError,
    );
    expect(() => new CalendarTokenCrypto([])).toThrow(CalendarCryptoError);
  });
});

describe('parseCalendarTokenKeys', () => {
  it('parses newest first and rejects bad input without echoing key material', () => {
    expect(keysOf(`v2:${k2}, v1:${k1}`).map((k) => k.id)).toEqual(['v2', 'v1']);
    const short = randomBytes(16).toString('base64');
    for (const raw of [
      '',
      `v1:${short}`,
      `v1:${randomBytes(33).toString('base64')}`,
      `:${k1}`,
      `v1${k1}`,
      `v1:not base64!`,
      `v1:${k1},v1:${k2}`,
      `bad.id:${k1}`,
    ]) {
      const r = parseCalendarTokenKeys(raw);
      expect(r.problems.length).toBeGreaterThan(0);
      expect(JSON.stringify(r.problems)).not.toContain(short);
      expect(JSON.stringify(r.problems)).not.toContain(k1);
    }
  });
});

describe('calendar config and startup', () => {
  it('is off by default with no keys', () => {
    expect(loadConfig({}).calendar).toEqual({
      enabled: false,
      tokenKeys: [],
      google: null,
      cron: null,
    });
  });

  it('refuses to start with FEATURE_CALENDAR=true and no key', () => {
    expect(() => loadConfig({ FEATURE_CALENDAR: 'true' })).toThrow(ConfigError);
    expect(() => loadConfig({ FEATURE_CALENDAR: 'true' })).toThrow(/CALENDAR_TOKEN_KEYS/);
    expect(() => loadConfig({ FEATURE_CALENDAR: 'true', CALENDAR_TOKEN_KEYS: '  ' })).toThrow(
      ConfigError,
    );
  });

  it('refuses to start with FEATURE_CALENDAR=true and no Google client, and trims base URLs', () => {
    const keys = `v1:${k1}`;
    expect(() => loadConfig({ FEATURE_CALENDAR: 'true', CALENDAR_TOKEN_KEYS: keys })).toThrow(
      /GOOGLE_CLIENT_ID/,
    );
    expect(() =>
      loadConfig({
        FEATURE_CALENDAR: 'true',
        CALENDAR_TOKEN_KEYS: keys,
        GOOGLE_CLIENT_ID: 'cid',
        GOOGLE_CLIENT_SECRET: 'csecret',
      }),
    ).toThrow(/GOOGLE_REDIRECT_URI/);
    const c = loadConfig({
      GOOGLE_CLIENT_ID: 'cid',
      GOOGLE_CLIENT_SECRET: 'csecret',
      GOOGLE_REDIRECT_URI: 'https://app.example.test/calendar/callback',
      GOOGLE_CALENDAR_API_BASE: 'http://127.0.0.1:9/calendar/v3/',
    });
    expect(c.calendar.google).toEqual({
      clientId: 'cid',
      clientSecret: 'csecret',
      redirectUri: 'https://app.example.test/calendar/callback',
      apiBase: 'http://127.0.0.1:9/calendar/v3',
      oauthBase: 'https://oauth2.googleapis.com',
    });
  });

  it('refuses to start with FEATURE_CALENDAR=true and an invalid key, without echoing it', () => {
    const short = randomBytes(16).toString('base64');
    let message = '';
    try {
      loadConfig({ FEATURE_CALENDAR: 'true', CALENDAR_TOKEN_KEYS: `v1:${short}` });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/32 bytes/);
    expect(message).not.toContain(short);
  });

  it('starts with a valid key set, and rejects an invalid set even when the flag is off', () => {
    const c = loadConfig({
      FEATURE_CALENDAR: 'true',
      CALENDAR_TOKEN_KEYS: `v2:${k2},v1:${k1}`,
      GOOGLE_CLIENT_ID: 'cid',
      GOOGLE_CLIENT_SECRET: 'csecret',
      GOOGLE_REDIRECT_URI: 'https://app.example.test/calendar/callback',
    });
    expect(c.calendar.enabled).toBe(true);
    expect(c.calendar.tokenKeys.map((k) => k.id)).toEqual(['v2', 'v1']);
    expect(() => loadConfig({ CALENDAR_TOKEN_KEYS: 'v1:abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ FEATURE_CALENDAR: 'yes' })).toThrow(/FEATURE_CALENDAR/);
  });
});
