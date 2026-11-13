import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { APP_CALENDAR_NAME, APP_EVENT_SOURCE } from '@upversion/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { CalendarTokenCrypto } from '../src/calendar-crypto';
import { createDatabase, type Database } from '../src/db/database';
import { createSupabaseVerifier } from '../src/modules/accounts/token-verifier';
import { CALENDAR_SCOPES } from '../src/modules/calendar/google-oauth';
import { acceptCurrentLegal, dbAvailable, prepareDatabase, type TestDb } from './db-helpers';
import { testApp, testConfig } from './helpers';
import { ISSUER, makeTestKeys, type TestKeys } from './tokens';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const PLAN_A = 'a0000000-0000-4000-8000-000000000001';
const REFRESH = 'refresh-token-plaintext-0001';
const ACCESS = 'access-token-plaintext-0001';
const CODE = 'auth-code-plaintext-0001';
const APP_KEY = Buffer.alloc(32, 7);
const CLIENT_SECRET = 'client-secret-plaintext';
const REDIRECT = 'https://app.example.test/calendar/callback';
const APP_CAL = 'app-cal@group.calendar.example';
const PRIMARY = 'a@example.com';

/** A small stand-in for Google: OAuth endpoints plus the few Calendar API calls the module makes. */
interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  auth: string | undefined;
  form: URLSearchParams;
}
interface Stub {
  server: Server;
  base: string;
  seen: Req[];
  /** What the authorization_code grant answers. */
  codeGrant: () => { status: number; body: unknown };
  /** What the refresh_token grant answers. */
  refreshGrant: () => { status: number; body: unknown };
  /** When set, every Calendar API call answers with this status. */
  apiStatus: number | null;
  calendars: { id: string; summary: string; primary?: boolean; accessRole: string }[];
  events: Map<string, Map<string, Record<string, unknown>>>;
}

const okTokens = () => ({
  status: 200,
  body: { access_token: ACCESS, refresh_token: REFRESH, scope: CALENDAR_SCOPES.join(' ') },
});

function startStub(): Promise<Stub> {
  const stub: Stub = {
    server: undefined as unknown as Server,
    base: '',
    seen: [],
    codeGrant: okTokens,
    refreshGrant: () => ({ status: 200, body: { access_token: 'access-2', expires_in: 3600 } }),
    apiStatus: null,
    calendars: [],
    events: new Map(),
  };
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  stub.server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://stub');
      const entry: Req = {
        method: req.method ?? '',
        path: url.pathname,
        query: url.searchParams,
        auth: req.headers.authorization,
        form: new URLSearchParams(Buffer.concat(chunks).toString()),
      };
      stub.seen.push(entry);
      if (entry.path === '/token') {
        const r =
          entry.form.get('grant_type') === 'refresh_token' ? stub.refreshGrant() : stub.codeGrant();
        return send(res, r.status, r.body);
      }
      if (entry.path === '/revoke') return send(res, 200, {});
      if (stub.apiStatus) return send(res, stub.apiStatus, { error: { errors: [] } });
      const api = entry.path.replace('/calendar/v3', '');
      if (entry.method === 'GET' && api === '/users/me/calendarList') {
        return send(res, 200, { items: stub.calendars });
      }
      if (entry.method === 'POST' && api === '/calendars') {
        const created = { id: APP_CAL, summary: APP_CALENDAR_NAME, accessRole: 'owner' };
        stub.calendars.push(created);
        return send(res, 200, created);
      }
      const ev = /^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(api);
      if (ev) {
        const bucket = stub.events.get(decodeURIComponent(ev[1]!)) ?? new Map();
        if (entry.method === 'GET' && !ev[2]) {
          // Hostile on purpose: ignores the tag filter, so the write guard has to do the checking.
          return send(res, 200, { items: [...bucket.values()] });
        }
        const found = ev[2] ? bucket.get(decodeURIComponent(ev[2])) : undefined;
        if (entry.method === 'GET') return found ? send(res, 200, found) : send(res, 404, {});
        if (entry.method === 'DELETE') {
          bucket.delete(decodeURIComponent(ev[2]!));
          res.writeHead(204);
          return res.end();
        }
      }
      send(res, 404, {});
    });
  });
  return new Promise((resolve) =>
    stub.server.listen(0, '127.0.0.1', () => {
      stub.base = `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}`;
      resolve(stub);
    }),
  );
}

const tagged = (id: string) => ({
  id,
  status: 'confirmed',
  start: { dateTime: '2026-11-03T09:00:00+00:00' },
  end: { dateTime: '2026-11-03T10:00:00+00:00' },
  extendedProperties: { private: { source: APP_EVENT_SOURCE, task_id: 't1' } },
});
const foreign = (id: string) => ({
  id,
  status: 'confirmed',
  start: { dateTime: '2026-11-03T11:00:00+00:00' },
  end: { dateTime: '2026-11-03T12:00:00+00:00' },
});

const sha256Hex = (v: string) => createHash('sha256').update(v).digest('hex');

describe('calendar routes with the feature flag off', () => {
  it('does not exist (404) and does not touch Google', async () => {
    const app = testApp();
    await app.ready();
    for (const [method, url] of [
      ['GET', '/api/v1/calendar'],
      ['POST', '/api/v1/calendar/connect'],
      ['POST', '/api/v1/calendar/callback'],
      ['PUT', '/api/v1/calendar/sources'],
      ['DELETE', '/api/v1/calendar'],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    await app.close();
  });

  it('exists (401 without a token) with the flag on', async () => {
    const google = {
      clientId: 'cid',
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT,
      apiBase: 'http://127.0.0.1:9/calendar/v3',
      oauthBase: 'http://127.0.0.1:9',
    };
    const app = testApp({
      calendar: { enabled: true, tokenKeys: [{ id: 'v1', key: randomBytes(32) }], google },
    });
    await app.ready();
    expect((await app.inject({ method: 'GET', url: '/api/v1/calendar' })).statusCode).toBe(401);
    await app.close();
  });
});

describe.skipIf(!dbAvailable)(
  'calendar connect and disconnect (real Postgres, stub Google)',
  () => {
    let testDb: TestDb;
    let db: Database;
    let keys: TestKeys;
    let stub: Stub;
    let app: ReturnType<typeof buildApp>;
    let logs: string[];

    beforeAll(async () => {
      testDb = await prepareDatabase();
      keys = await makeTestKeys();
      stub = await startStub();
      db = createDatabase({ connectionString: testDb.appUrl('rnd'), appEnv: 'rnd' });
      logs = [];
      app = buildApp(
        testConfig({
          appEnv: 'rnd',
          rateLimitPerMinute: 100_000,
          logLevel: 'trace',
          calendar: {
            enabled: true,
            tokenKeys: [{ id: 'v1', key: APP_KEY }],
            google: {
              clientId: 'client-id',
              clientSecret: CLIENT_SECRET,
              redirectUri: REDIRECT,
              apiBase: `${stub.base}/calendar/v3`,
              oauthBase: stub.base,
            },
          },
        }),
        {
          verifier: createSupabaseVerifier({ issuer: ISSUER, keys: keys.keys }),
          db,
          logStream: { write: (line) => logs.push(line) },
        },
      );
      await app.ready();
    });

    afterAll(async () => {
      await app?.close();
      await db?.close();
      await new Promise((r) => stub.server.close(r));
    });

    beforeEach(async () => {
      stub.seen.length = 0;
      stub.codeGrant = okTokens;
      stub.refreshGrant = () => ({
        status: 200,
        body: { access_token: 'access-2', expires_in: 3600 },
      });
      stub.apiStatus = null;
      stub.calendars = [
        { id: PRIMARY, summary: 'Personal', primary: true, accessRole: 'owner' },
        { id: 'work@example.com', summary: 'Work', accessRole: 'reader' },
      ];
      stub.events = new Map();
      logs.length = 0;
      await testDb.admin(async (c) => {
        await c.query('delete from rnd.app_users');
        await c.query('delete from rnd.allowed_emails');
        await c.query(
          `insert into rnd.allowed_emails (email) values ('a@example.com'), ('b@example.com')`,
        );
        await c.query(
          `insert into rnd.app_users (id, email) values ($1, 'a@example.com'), ($2, 'b@example.com')`,
          [A, B],
        );
        await acceptCurrentLegal(c, [A, B]);
        await c.query(
          `insert into rnd.plans (user_id, id, created_from, name, start_date)
         values ($1, $2, 'builder', 'Plan', '2026-11-01')`,
          [A, PLAN_A],
        );
      });
    });

    afterEach(() => {
      // Whatever happened in the test, no secret may have reached the logs.
      const all = logs.join('\n');
      for (const secret of [REFRESH, ACCESS, CODE, CLIENT_SECRET, 'access-2']) {
        expect(all).not.toContain(secret);
      }
    });

    const as = async (sub: string, email: string) => ({
      authorization: `Bearer ${await keys.sign({ sub, email })}`,
    });
    const asA = () => as(A, 'a@example.com');
    const asB = () => as(B, 'b@example.com');
    const call = (
      method: 'GET' | 'POST' | 'PUT' | 'DELETE',
      url: string,
      headers: Record<string, string>,
      payload?: unknown,
    ) =>
      app.inject({
        method,
        url: `/api/v1${url}`,
        headers,
        ...(payload === undefined ? {} : { payload: payload as object }),
      });
    const rows = <R = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      testDb.admin(async (c) => (await c.query(sql, params)).rows as R[]);

    const storedCiphertext = async () =>
      (
        await rows<{ refresh_token_ciphertext: string }>(
          'select refresh_token_ciphertext from rnd.calendar_connections',
        )
      )[0]!.refresh_token_ciphertext;

    /** Runs POST /calendar/connect and returns the state and challenge Google would see. */
    const connect = async (headers: Record<string, string>) => {
      const res = await call('POST', '/calendar/connect', headers);
      expect(res.statusCode).toBe(200);
      const url = new URL(res.json().authorizationUrl);
      return { url, state: url.searchParams.get('state')!, res };
    };
    const callback = (headers: Record<string, string>, state: string, code = CODE) =>
      call('POST', '/calendar/callback', headers, { code, state });
    const connected = async (headers: Record<string, string>) => {
      const { state } = await connect(headers);
      const res = await callback(headers, state);
      expect(res.statusCode).toBe(200);
      return res;
    };

    describe('POST /calendar/connect', () => {
      it('returns a Google URL with PKCE, state, offline access and exactly the two scopes', async () => {
        const { url, state } = await connect(await asA());
        expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
        const p = url.searchParams;
        expect(p.get('client_id')).toBe('client-id');
        expect(p.get('redirect_uri')).toBe(REDIRECT);
        expect(p.get('response_type')).toBe('code');
        expect(p.get('code_challenge_method')).toBe('S256');
        expect(p.get('access_type')).toBe('offline');
        expect(p.get('prompt')).toBe('consent');
        expect(p.get('include_granted_scopes')).toBe('false');
        expect(p.get('scope')!.split(' ').sort()).toEqual([
          'https://www.googleapis.com/auth/calendar.app.created',
          'https://www.googleapis.com/auth/calendar.readonly',
        ]);
        expect(state.length).toBeGreaterThanOrEqual(43);
        expect(url.toString()).not.toContain(CLIENT_SECRET);
      });

      it('stores the state hashed and the verifier encrypted, for 10 minutes', async () => {
        const { url, state } = await connect(await asA());
        const [row] = await rows<{
          user_id: string;
          state_hash: string;
          pkce_verifier_ciphertext: string;
          created_at: Date;
          expires_at: Date;
        }>('select * from rnd.calendar_oauth_states');
        expect(row!.user_id).toBe(A);
        expect(row!.state_hash).toBe(sha256Hex(state));
        expect(row!.state_hash).not.toContain(state);
        expect(row!.expires_at.getTime() - row!.created_at.getTime()).toBe(10 * 60 * 1000);
        // Encrypted with the API's key (not ours), so it is opaque here; it must not be the raw value.
        expect(row!.pkce_verifier_ciphertext).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
        expect(url.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
      });

      it('deletes only the caller’s expired states on each insert', async () => {
        await rows(
          `insert into rnd.calendar_oauth_states (user_id, state_hash, pkce_verifier_ciphertext, created_at, expires_at)
         values ($1, 'a-old-hash-0000000000', 'x', now() - interval '2 hours', now() - interval '1 hour'),
                ($2, 'b-old-hash-0000000000', 'x', now() - interval '2 hours', now() - interval '1 hour')`,
          [A, B],
        );
        await connect(await asA());
        const left = await rows<{ state_hash: string }>(
          'select state_hash from rnd.calendar_oauth_states order by state_hash',
        );
        expect(left.map((r) => r.state_hash)).not.toContain('a-old-hash-0000000000');
        expect(left.map((r) => r.state_hash)).toContain('b-old-hash-0000000000');
      });

      it('keeps at most 10 open states per user', async () => {
        const h = await asA();
        for (let i = 0; i < 13; i += 1) await connect(h);
        const open = await rows('select 1 from rnd.calendar_oauth_states where user_id = $1', [A]);
        expect(open).toHaveLength(10);
      });
    });

    describe('POST /calendar/callback', () => {
      it('stores ciphertext (not plaintext), creates the calendar and the default sources', async () => {
        const h = await asA();
        const { url, state } = await connect(h);
        const res = await callback(h, state);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
          status: 'connected',
          lastSyncedAt: null,
          lastErrorCode: null,
          autoSync: true,
          sources: [
            { calendarId: PRIMARY, name: 'Personal', blocksTime: true },
            { calendarId: 'work@example.com', name: 'Work', blocksTime: false },
          ],
        });

        // The token request carried the code, the client, the redirect and a verifier matching the challenge.
        const exchange = stub.seen.find((r) => r.path === '/token')!;
        expect(exchange.form.get('grant_type')).toBe('authorization_code');
        expect(exchange.form.get('code')).toBe(CODE);
        expect(exchange.form.get('redirect_uri')).toBe(REDIRECT);
        expect(exchange.form.get('client_secret')).toBe(CLIENT_SECRET);
        const verifier = exchange.form.get('code_verifier')!;
        expect(createHash('sha256').update(verifier).digest('base64url')).toBe(
          url.searchParams.get('code_challenge'),
        );

        const [conn] = await rows<{
          status: string;
          app_calendar_id: string;
          refresh_token_ciphertext: string;
          granted_scopes: string[];
        }>('select * from rnd.calendar_connections where user_id = $1', [A]);
        expect(conn!.status).toBe('connected');
        expect(conn!.app_calendar_id).toBe(APP_CAL);
        expect(conn!.refresh_token_ciphertext).not.toContain(REFRESH);
        expect(conn!.refresh_token_ciphertext).toMatch(/^v1\./);
        expect([...conn!.granted_scopes].sort()).toEqual([...CALENDAR_SCOPES].sort());
        expect(
          stub.seen.filter((r) => r.method === 'POST' && r.path.endsWith('/calendars')),
        ).toHaveLength(1);
        // Single use: the state is gone.
        expect(await rows('select 1 from rnd.calendar_oauth_states')).toHaveLength(0);
        // The user's email is never sent to the OAuth endpoints.
        expect(JSON.stringify(stub.seen.filter((r) => r.path === '/token'))).not.toContain(
          'example.com',
        );
      });

      it('can decrypt the stored refresh token only for the owner', async () => {
        const appCrypto = new CalendarTokenCrypto([{ id: 'v1', key: APP_KEY }]);
        await connected(await asA());
        const ct = await storedCiphertext();
        expect(appCrypto.decrypt(ct, A)).toBe(REFRESH);
        expect(() => appCrypto.decrypt(ct, B)).toThrow();
      });

      it('rejects narrowed scopes, connects nothing and revokes the grant', async () => {
        stub.codeGrant = () => ({
          status: 200,
          body: { access_token: ACCESS, refresh_token: REFRESH, scope: CALENDAR_SCOPES[1] },
        });
        const h = await asA();
        const { state } = await connect(h);
        const res = await callback(h, state);
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('scopes_not_granted');
        const revoke = stub.seen.find((r) => r.path === '/revoke');
        expect(revoke?.form.get('token')).toBe(REFRESH);
        expect(await rows('select 1 from rnd.calendar_connections')).toHaveLength(0);
        expect(stub.seen.some((r) => r.path.startsWith('/calendar/v3'))).toBe(false);
      });

      it('rejects a missing refresh token and revokes the access token', async () => {
        stub.codeGrant = () => ({
          status: 200,
          body: { access_token: ACCESS, scope: CALENDAR_SCOPES.join(' ') },
        });
        const h = await asA();
        const { state } = await connect(h);
        const res = await callback(h, state);
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('no_refresh_token');
        expect(stub.seen.find((r) => r.path === '/revoke')?.form.get('token')).toBe(ACCESS);
        expect(await rows('select 1 from rnd.calendar_connections')).toHaveLength(0);
      });

      it('rejects an expired state and removes it, without calling Google', async () => {
        await rows(
          `insert into rnd.calendar_oauth_states (user_id, state_hash, pkce_verifier_ciphertext, created_at, expires_at)
         values ($1, $2, 'x', now() - interval '2 hours', now() - interval '1 hour')`,
          [A, sha256Hex('expired-state-value-0001')],
        );
        const res = await callback(await asA(), 'expired-state-value-0001');
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('invalid_state');
        expect(await rows('select 1 from rnd.calendar_oauth_states')).toHaveLength(0);
        expect(stub.seen).toHaveLength(0);
      });

      it('rejects an unknown state', async () => {
        const res = await callback(await asA(), 'never-issued-state-0000001');
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('invalid_state');
        expect(stub.seen).toHaveLength(0);
      });

      it('rejects a replayed state', async () => {
        const h = await asA();
        const { state } = await connect(h);
        expect((await callback(h, state)).statusCode).toBe(200);
        stub.seen.length = 0;
        const again = await callback(h, state);
        expect(again.statusCode).toBe(400);
        expect(again.json().error.code).toBe('invalid_state');
        expect(stub.seen).toHaveLength(0);
      });

      it('does not let user B complete user A’s state, and leaves it usable by A', async () => {
        const { state } = await connect(await asA());
        const stolen = await callback(await asB(), state);
        expect(stolen.statusCode).toBe(400);
        expect(stolen.json().error.code).toBe('invalid_state');
        expect(stub.seen).toHaveLength(0);
        expect(await rows('select 1 from rnd.calendar_connections')).toHaveLength(0);
        // A's attempt was not consumed by B's try.
        expect((await callback(await asA(), state)).statusCode).toBe(200);
        expect(
          (await rows('select user_id from rnd.calendar_connections')).map((r) => r.user_id),
        ).toEqual([A]);
      });

      it('takes the user from the token only: a userId in the body is refused', async () => {
        const { state } = await connect(await asA());
        const res = await call('POST', '/calendar/callback', await asB(), {
          code: CODE,
          state,
          userId: A,
        });
        expect(res.statusCode).toBe(400);
        expect(stub.seen).toHaveLength(0);
      });

      it('answers 400 when Google rejects the code, and 502 when Google is down', async () => {
        const h = await asA();
        stub.codeGrant = () => ({ status: 400, body: { error: 'invalid_grant' } });
        let res = await callback(h, (await connect(h)).state);
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('code_rejected');
        stub.codeGrant = () => ({ status: 503, body: {} });
        res = await callback(h, (await connect(h)).state);
        expect(res.statusCode).toBe(502);
        expect(await rows('select 1 from rnd.calendar_connections')).toHaveLength(0);
      });

      it('reuses the stored app calendar when it still exists, and keeps the user’s choices', async () => {
        const h = await asA();
        await connected(h);
        await call('PUT', '/calendar/sources', h, {
          sources: [
            { calendarId: PRIMARY, blocksTime: false },
            { calendarId: 'work@example.com', blocksTime: true },
          ],
        });
        stub.seen.length = 0;
        const res = await connected(h);
        expect(stub.seen.some((r) => r.method === 'POST' && r.path.endsWith('/calendars'))).toBe(
          false,
        );
        expect(res.json().sources).toEqual([
          { calendarId: 'work@example.com', name: 'Work', blocksTime: true },
          { calendarId: PRIMARY, name: 'Personal', blocksTime: false },
        ]);
        // The app calendar is never a source.
        expect(res.json().sources.map((s: { calendarId: string }) => s.calendarId)).not.toContain(
          APP_CAL,
        );
      });

      it('creates a new app calendar when the stored one was deleted at Google', async () => {
        const h = await asA();
        await connected(h);
        stub.calendars = stub.calendars.filter((c) => c.id !== APP_CAL);
        stub.seen.length = 0;
        await connected(h);
        expect(
          stub.seen.filter((r) => r.method === 'POST' && r.path.endsWith('/calendars')),
        ).toHaveLength(1);
      });

      it('overwrites the stored token on reconnect without revoking the old one', async () => {
        const h = await asA();
        await connected(h);
        stub.codeGrant = () => ({
          status: 200,
          body: {
            access_token: ACCESS,
            refresh_token: 'refresh-token-plaintext-0002',
            scope: CALENDAR_SCOPES.join(' '),
          },
        });
        stub.seen.length = 0;
        await connected(h);
        // No revoke: Google may end the whole grant, which would kill the new token too.
        expect(stub.seen.some((r) => r.path === '/revoke')).toBe(false);
        const appCrypto = new CalendarTokenCrypto([{ id: 'v1', key: APP_KEY }]);
        expect(appCrypto.decrypt(await storedCiphertext(), A)).toBe('refresh-token-plaintext-0002');
      });

      it('leaves a healthy connection unflagged when a reconnect fails with invalid_grant', async () => {
        const h = await asA();
        await connected(h);
        stub.refreshGrant = () => ({ status: 400, body: { error: 'invalid_grant' } });
        stub.apiStatus = 401;
        const { state } = await connect(h);
        const res = await callback(h, state);
        expect(res.statusCode).toBe(409);
        expect((await call('GET', '/calendar', h)).json()).toMatchObject({
          status: 'connected',
          lastErrorCode: null,
        });
        // The new token was not left alive.
        expect(stub.seen.some((r) => r.path === '/revoke')).toBe(true);
      });

      it('clears needs_reconnect when the user reconnects', async () => {
        const h = await asA();
        await connected(h);
        await rows(
          `update rnd.calendar_connections set status = 'needs_reconnect', last_error_code = 'invalid_grant'`,
        );
        const res = await connected(h);
        expect(res.json().status).toBe('connected');
        expect(res.json().lastErrorCode).toBeNull();
      });
    });

    describe('GET /calendar', () => {
      it('is disconnected for a user without a connection', async () => {
        const res = await call('GET', '/calendar', await asA());
        expect(res.json()).toEqual({
          status: 'disconnected',
          lastSyncedAt: null,
          lastErrorCode: null,
          autoSync: true,
          sources: [],
        });
      });

      it('never returns tokens, ciphertext or ids that are not the user’s to see', async () => {
        const h = await asA();
        await connected(h);
        const ct = await storedCiphertext();
        const res = await call('GET', '/calendar', h);
        expect(res.statusCode).toBe(200);
        const body = res.body;
        for (const secret of [REFRESH, ACCESS, CODE, ct, APP_CAL, 'refresh', 'ciphertext']) {
          expect(body).not.toContain(secret);
        }
        expect(Object.keys(res.json()).sort()).toEqual([
          'autoSync',
          'lastErrorCode',
          'lastSyncedAt',
          'sources',
          'status',
        ]);
        // Another user sees nothing of it.
        expect((await call('GET', '/calendar', await asB())).json().status).toBe('disconnected');
      });
    });

    describe('PUT /calendar/sources', () => {
      it('sets which calendars block time', async () => {
        const h = await asA();
        await connected(h);
        const res = await call('PUT', '/calendar/sources', h, {
          sources: [
            { calendarId: PRIMARY, blocksTime: false },
            { calendarId: 'work@example.com', blocksTime: true },
          ],
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().sources).toEqual([
          { calendarId: 'work@example.com', name: 'Work', blocksTime: true },
          { calendarId: PRIMARY, name: 'Personal', blocksTime: false },
        ]);
      });

      it('answers 404 for a calendar that is not a source and changes nothing', async () => {
        const h = await asA();
        await connected(h);
        const res = await call('PUT', '/calendar/sources', h, {
          sources: [
            { calendarId: PRIMARY, blocksTime: false },
            { calendarId: 'nope@example.com', blocksTime: true },
          ],
        });
        expect(res.statusCode).toBe(404);
        const [row] = await rows<{ blocks_time: boolean }>(
          'select blocks_time from rnd.calendar_sources where calendar_id = $1',
          [PRIMARY],
        );
        expect(row!.blocks_time).toBe(true);
      });

      it('cannot change another user’s sources', async () => {
        await connected(await asA());
        const res = await call('PUT', '/calendar/sources', await asB(), {
          sources: [{ calendarId: PRIMARY, blocksTime: false }],
        });
        expect(res.statusCode).toBe(404);
        const [row] = await rows<{ blocks_time: boolean }>(
          'select blocks_time from rnd.calendar_sources where user_id = $1 and calendar_id = $2',
          [A, PRIMARY],
        );
        expect(row!.blocks_time).toBe(true);
      });
    });

    describe('DELETE /calendar', () => {
      const seedRows = async () => {
        await rows(
          `insert into rnd.calendar_event_links (user_id, plan_id, block_key, task_id, event_id, last_start, last_end)
         values ($1, $2, 'k1', 't1', 'ev1', now(), now() + interval '1 hour')`,
          [A, PLAN_A],
        );
        await rows(
          `insert into rnd.calendar_locked_blocks (user_id, plan_id, block_key, task_id, starts_at, ends_at, reason)
         values ($1, $2, 'k1', 't1', now(), now() + interval '1 hour', 'moved')`,
          [A, PLAN_A],
        );
        await rows(
          `insert into rnd.calendar_busy (user_id, date, external_event_id, source_calendar_id, start_minute, end_minute, kind)
         values ($1, '2026-11-03', 'x1', $2, 600, 660, 'busy')`,
          [A, PRIMARY],
        );
      };
      const count = async (table: string, user = A) =>
        Number(
          (
            await rows<{ n: string }>(
              `select count(*)::text as n from rnd.${table} where user_id = $1`,
              [user],
            )
          )[0]!.n,
        );

      it('deletes only the app’s events, revokes the token and clears every row', async () => {
        const h = await asA();
        await connected(h);
        await seedRows();
        stub.events.set(
          APP_CAL,
          new Map([
            ['mine1', tagged('mine1')],
            ['mine2', tagged('mine2')],
            ['theirs', foreign('theirs')],
          ]),
        );
        stub.events.set(PRIMARY, new Map([['personal', foreign('personal')]]));
        stub.seen.length = 0;

        const res = await call('DELETE', '/calendar', h);
        expect(res.statusCode).toBe(204);

        const deleted = stub.seen.filter((r) => r.method === 'DELETE').map((r) => r.path);
        expect(deleted.sort()).toEqual([
          `/calendar/v3/calendars/${encodeURIComponent(APP_CAL)}/events/mine1`,
          `/calendar/v3/calendars/${encodeURIComponent(APP_CAL)}/events/mine2`,
        ]);
        // Never the calendar itself, never a foreign event.
        expect(stub.seen.some((r) => r.method === 'DELETE' && !r.path.includes('/events/'))).toBe(
          false,
        );
        expect(stub.events.get(APP_CAL)!.has('theirs')).toBe(true);
        expect(stub.events.get(PRIMARY)!.has('personal')).toBe(true);
        expect(stub.seen.find((r) => r.path === '/revoke')?.form.get('token')).toBe(REFRESH);

        for (const table of [
          'calendar_connections',
          'calendar_sources',
          'calendar_event_links',
          'calendar_locked_blocks',
          'calendar_busy',
          'calendar_oauth_states',
        ]) {
          expect(await count(table), table).toBe(0);
        }
        // The plan is untouched.
        expect(await count('plans')).toBe(1);
        expect((await call('GET', '/calendar', h)).json().status).toBe('disconnected');
      });

      it('leaves another user’s calendar data alone', async () => {
        await connected(await asA());
        await rows(
          `insert into rnd.calendar_connections (user_id, app_calendar_id, status) values ($1, 'b-cal', 'connected')`,
          [B],
        );
        await rows(
          `insert into rnd.calendar_sources (user_id, calendar_id, name, blocks_time) values ($1, 'b-src', 'B', true)`,
          [B],
        );
        expect((await call('DELETE', '/calendar', await asA())).statusCode).toBe(204);
        expect(await count('calendar_connections', B)).toBe(1);
        expect(await count('calendar_sources', B)).toBe(1);
      });

      it('is fine for a user who is not connected', async () => {
        expect((await call('DELETE', '/calendar', await asA())).statusCode).toBe(204);
      });

      it('keeps everything and answers 502 when Google cannot be reached', async () => {
        const h = await asA();
        await connected(h);
        stub.apiStatus = 503;
        const res = await call('DELETE', '/calendar', h);
        expect(res.statusCode).toBe(502);
        expect(res.json().error.code).toBe('calendar_unavailable');
        expect(await count('calendar_connections')).toBe(1);
        expect(await count('calendar_sources')).toBe(2);
        expect(stub.seen.some((r) => r.path === '/revoke')).toBe(false);
      });

      it('still disconnects when Google rejects the credentials (invalid_grant)', async () => {
        const h = await asA();
        await connected(h);
        await seedRows();
        stub.refreshGrant = () => ({ status: 400, body: { error: 'invalid_grant' } });
        stub.apiStatus = 401; // the first access token is rejected, forcing a refresh
        stub.seen.length = 0;
        const res = await call('DELETE', '/calendar', h);
        expect(res.statusCode).toBe(204);
        expect(stub.seen.some((r) => r.method === 'DELETE')).toBe(false);
        for (const table of ['calendar_connections', 'calendar_sources', 'calendar_event_links']) {
          expect(await count(table), table).toBe(0);
        }
        expect((await call('GET', '/calendar', h)).json().status).toBe('disconnected');
        expect(logs.join('\n')).toContain('credentials no longer work');
      });

      it('does not treat invalid_client as revoked consent: 502, no flag, data kept', async () => {
        const h = await asA();
        await connected(h);
        stub.refreshGrant = () => ({ status: 401, body: { error: 'invalid_client' } });
        stub.apiStatus = 401; // forces a refresh, which our client credentials fail
        const res = await call('DELETE', '/calendar', h);
        expect(res.statusCode).toBe(502);
        expect(await count('calendar_connections')).toBe(1);
        expect(await count('calendar_sources')).toBe(2);
        expect((await call('GET', '/calendar', h)).json()).toMatchObject({
          status: 'connected',
          lastErrorCode: null,
        });
      });

      it('still disconnects when the stored token is unreadable', async () => {
        const h = await asA();
        await connected(h);
        await rows(
          `update rnd.calendar_connections set refresh_token_ciphertext = 'v1.AAAA.AAAA.AAAA'`,
        );
        expect((await call('DELETE', '/calendar', h)).statusCode).toBe(204);
        expect(await count('calendar_connections')).toBe(0);
      });

      it('disconnects a connection that is already marked needs_reconnect', async () => {
        const h = await asA();
        await connected(h);
        await rows(
          `update rnd.calendar_connections set status = 'needs_reconnect', last_error_code = 'invalid_grant'`,
        );
        stub.apiStatus = 401;
        stub.refreshGrant = () => ({ status: 400, body: { error: 'invalid_grant' } });
        expect((await call('DELETE', '/calendar', h)).statusCode).toBe(204);
        expect((await call('GET', '/calendar', h)).json().status).toBe('disconnected');
      });
    });

    describe('account deletion', () => {
      const deleteAccount = async (h: Record<string, string>) =>
        call('DELETE', '/me', h, { confirmation: 'delete my account' });

      it('deletes the app’s events and revokes the token before the data goes', async () => {
        const h = await asA();
        await connected(h);
        stub.events.set(
          APP_CAL,
          new Map([
            ['mine1', tagged('mine1')],
            ['theirs', foreign('theirs')],
          ]),
        );
        stub.seen.length = 0;
        const res = await deleteAccount(h);
        expect(res.statusCode).toBe(204);
        expect(stub.seen.filter((r) => r.method === 'DELETE').map((r) => r.path)).toEqual([
          `/calendar/v3/calendars/${encodeURIComponent(APP_CAL)}/events/mine1`,
        ]);
        expect(stub.events.get(APP_CAL)!.has('theirs')).toBe(true);
        expect(stub.seen.find((r) => r.path === '/revoke')?.form.get('token')).toBe(REFRESH);
        expect(await rows('select 1 from rnd.app_users where id = $1', [A])).toHaveLength(0);
        expect(
          await rows('select 1 from rnd.calendar_connections where user_id = $1', [A]),
        ).toHaveLength(0);
      });

      it('still deletes the account when Google is unreachable, and logs no secret', async () => {
        const h = await asA();
        await connected(h);
        stub.apiStatus = 503;
        const res = await deleteAccount(h);
        expect(res.statusCode).toBe(204);
        expect(await rows('select 1 from rnd.app_users where id = $1', [A])).toHaveLength(0);
        expect(
          await rows('select 1 from rnd.calendar_connections where user_id = $1', [A]),
        ).toHaveLength(0);
        expect(logs.join('\n')).toContain(
          'calendar cleanup before account deletion did not finish',
        );
      });

      it('still deletes the account when the token is revoked (invalid_grant)', async () => {
        const h = await asA();
        await connected(h);
        stub.apiStatus = 401;
        stub.refreshGrant = () => ({ status: 400, body: { error: 'invalid_grant' } });
        expect((await deleteAccount(h)).statusCode).toBe(204);
        expect(await rows('select 1 from rnd.app_users where id = $1', [A])).toHaveLength(0);
      });

      it('does nothing at Google for a user without a connection', async () => {
        stub.seen.length = 0;
        expect((await deleteAccount(await asA())).statusCode).toBe(204);
        expect(stub.seen).toHaveLength(0);
      });
    });
  },
);
