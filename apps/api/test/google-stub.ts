import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A small stand-in for Google Calendar and its token endpoint (shared by the sync and cron tests). */

export type Raw = Record<string, unknown> & { id: string };
export interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
}

/**
 * Events per calendar with a change counter, so sync tokens work: a token is `tok-<counter>` and
 * an incremental listing returns what changed after it (cancelled events included). A deleted
 * event stays as `cancelled` with its tags, the way Google keeps it.
 */
export class GoogleStub {
  server!: Server;
  base = '';
  seen: Seen[] = [];
  cals = new Map<string, Map<string, { raw: Raw; seq: number }>>();
  seq = 0;
  /** Every Calendar API call answers with this status. */
  failWith: number | null = null;
  /** The refresh-token grant answers invalid_grant. */
  grantRevoked = false;
  /** Incremental listings answer 410. */
  tokensExpired = false;
  /** A delete removes the event entirely (404 afterwards) instead of cancelling it. */
  hardDelete = false;
  /** The next N event deletes answer 412 (the event changed meanwhile). */
  deletePrecondition = 0;
  /** Every event delete answers this status. */
  deleteFailsWith: number | null = null;
  pageSize = 3;
  /** Calendar ids whose requests answer 503 (the others work). */
  failCals = new Set<string>();
  /** Holds the first event insert until released; see `holdInserts`. */
  hold: { mark: () => void; gate: Promise<void> } | null = null;
  holdInserts(): { reached: Promise<void>; release: () => void } {
    let mark!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((r) => (mark = r));
    const gate = new Promise<void>((r) => (release = r));
    this.hold = { mark, gate };
    return { reached, release };
  }

  put(cal: string, raw: Raw): void {
    if (!this.cals.has(cal)) this.cals.set(cal, new Map());
    this.seq += 1;
    this.cals.get(cal)!.set(raw.id, { raw: { ...raw, etag: `e${this.seq}` }, seq: this.seq });
  }
  get(cal: string, id: string): Raw | undefined {
    return this.cals.get(cal)?.get(id)?.raw;
  }
  /** Simulates the user deleting an event in Google Calendar. */
  userDelete(cal: string, id: string): void {
    const cur = this.get(cal, id)!;
    if (this.hardDelete) this.cals.get(cal)!.delete(id);
    else this.put(cal, { ...cur, status: 'cancelled' });
  }
  /** Live (not cancelled) events of a calendar. */
  live(cal: string): Raw[] {
    return [...(this.cals.get(cal)?.values() ?? [])]
      .map((e) => e.raw)
      .filter((e) => e.status !== 'cancelled');
  }
  writes(): Seen[] {
    return this.seen.filter(
      (s) => s.path.includes('/events') && ['POST', 'PATCH', 'DELETE'].includes(s.method),
    );
  }
  eventListings(cal: string): Seen[] {
    return this.seen.filter(
      (s) => s.method === 'GET' && s.path.endsWith(`/calendars/${encodeURIComponent(cal)}/events`),
    );
  }

  start(): Promise<void> {
    const send = (res: ServerResponse, status: number, body: unknown, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', async () => {
        const url = new URL(req.url ?? '/', 'http://stub');
        const text = Buffer.concat(chunks).toString();
        if (url.pathname === '/token') {
          return this.grantRevoked
            ? send(res, 400, { error: 'invalid_grant' })
            : send(res, 200, { access_token: 'access-sync', expires_in: 3600 });
        }
        if (url.pathname === '/revoke') return send(res, 200, {});
        this.seen.push({ method: req.method ?? '', path: url.pathname, query: url.searchParams });
        if (this.failWith) {
          return send(
            res,
            this.failWith,
            { error: { errors: [{ reason: 'backendError' }] } },
            {
              'retry-after': '30',
            },
          );
        }
        const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(url.pathname);
        if (!m) return send(res, 404, {});
        const cal = decodeURIComponent(m[1]!);
        if (this.failCals.has(cal)) {
          return send(res, 503, { error: { errors: [{ reason: 'backendError' }] } });
        }
        if (this.hold && req.method === 'POST' && !m[2]) {
          const held = this.hold;
          this.hold = null; // only the first insert waits
          held.mark();
          await held.gate;
        }
        const id = m[2] ? decodeURIComponent(m[2]) : undefined;
        const bucket = this.cals.get(cal) ?? new Map();
        const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};

        if (req.method === 'GET' && !id) {
          const token = url.searchParams.get('syncToken');
          let items: { raw: Raw; seq: number }[];
          if (token) {
            if (this.tokensExpired) return send(res, 410, { error: { errors: [] } });
            const after = Number(token.replace('tok-', ''));
            items = [...bucket.values()].filter((e) => e.seq > after);
          } else {
            const showDeleted = url.searchParams.get('showDeleted') === 'true';
            items = [...bucket.values()].filter((e) => showDeleted || e.raw.status !== 'cancelled');
          }
          const from = Number(url.searchParams.get('pageToken') ?? 0);
          const page = items.slice(from, from + this.pageSize);
          const more = from + this.pageSize < items.length;
          return send(res, 200, {
            items: page.map((e) =>
              e.raw.status === 'cancelled' && token ? { id: e.raw.id, status: 'cancelled' } : e.raw,
            ),
            ...(more ? { nextPageToken: String(from + this.pageSize) } : {}),
            ...(more ? {} : { nextSyncToken: `tok-${this.seq}` }),
          });
        }
        if (req.method === 'POST' && !id) {
          const newId = body.id as string;
          if (bucket.has(newId)) return send(res, 409, { error: { errors: [] } });
          this.put(cal, { status: 'confirmed', ...body, id: newId } as Raw);
          return send(res, 200, this.get(cal, newId));
        }
        const found = id ? bucket.get(id) : undefined;
        if (!found) return send(res, 404, {});
        if (req.method === 'GET') return send(res, 200, found.raw);
        if (req.method === 'PATCH') {
          const ifMatch = req.headers['if-match'];
          if (ifMatch && ifMatch !== found.raw.etag) return send(res, 412, {});
          const tags = (body.extendedProperties as { private?: object } | undefined)?.private;
          const prev = (found.raw.extendedProperties as { private?: object } | undefined)?.private;
          this.put(cal, {
            ...found.raw,
            ...body,
            ...(tags ? { extendedProperties: { private: { ...prev, ...tags } } } : {}),
          } as Raw);
          return send(res, 200, this.get(cal, id!));
        }
        if (req.method === 'DELETE') {
          if (this.deleteFailsWith) return send(res, this.deleteFailsWith, {});
          if (this.deletePrecondition > 0) {
            this.deletePrecondition -= 1;
            return send(res, 412, {});
          }
          if (this.hardDelete) bucket.delete(id!);
          else this.put(cal, { ...found.raw, status: 'cancelled' });
          res.writeHead(204);
          return res.end();
        }
        send(res, 404, {});
      });
    });
    return new Promise((resolve) =>
      this.server.listen(0, '127.0.0.1', () => {
        this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
        resolve();
      }),
    );
  }
}
