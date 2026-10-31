// Teacher accounts, the same file on all four uploadmy sites (laser, model, code, cut). Edit it in one
// site and copy it to the other three, byte for byte (Dalton 2026-10-30: each teacher picks their own
// password; teachers are equals).
//
// - Accounts live in TEACHERS_KV, ONE namespace bound to all four Workers, so a password set on one
//   site works on every site. Only a salted PBKDF2 value is stored, never the password.
// - A new teacher (or one who forgot) gets a one-time start code (21 days) from any signed-in teacher, signs in
//   with it, and must choose a password before anything else (`setup` sessions reach only the
//   account routes, `setupAllows`).
// - Signing in gives a session token, signed with this site's TEACHER_SESSION_KEY secret. A token
//   carries the account's version: a new password or start code bumps it, which ends every older
//   session within about a minute (KV caching).
// - The old shared TEACHER_KEY / TEACHER_KEY_2 still work as "Shared key" until those secrets are
//   deleted, so nobody is locked out during the switch.
// - Wrong tries go through each site's own lockout: the site's teacher gate calls `checkCredential`
//   and counts a null answer as a wrong key, exactly as it counted a wrong shared key.
// - On top of that, each NAME pauses after 10 wrong passwords in a row (on any of the four sites,
//   from anywhere): 1 minute, doubling to 15 (Dalton 2026-10-30). Sessions keep working, so a student
//   typing wrong passwords for a teacher can only delay that teacher signing in on a new computer.
//
// No Workers-only APIs (the tests run it in Node).

/** The slice of a KV namespace this file uses. */
export interface KvLike {
  get(key: string, opts: { type: 'json'; cacheTtl?: number }): Promise<unknown>;
  put(key: string, value: string, opts?: { metadata?: unknown; expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts: { prefix: string; cursor?: string }): Promise<{ keys: { name: string; metadata?: unknown }[]; list_complete: boolean; cursor?: string }>;
}

export interface TeacherEnv {
  TEACHERS_KV?: KvLike;
  TEACHER_SESSION_KEY?: string; // secret, one per site
  TEACHER_KEY?: string; // old shared key
  TEACHER_KEY_2?: string; // old second shared key
}

/** Who a teacher request comes from. `setup`: signed in with a start code, must choose a password first. */
export interface Who { id: string; name: string; via: 'account' | 'shared'; setup: boolean }

/** A sign-in typed on the teacher page (sent in the body, never in a header). */
export interface PasswordCredential { id: string; password: string }

export const MIN_PASSWORD = 10;
export const MAX_PASSWORD = 200;
export const SESSION_DAYS = 30;
const SETUP_MINUTES = 30;
const START_CODE_DAYS = 21; // a week off must not use them up (Dalton 2026-10-30: 14+ days)
const ITERATIONS = 100_000; // the most PBKDF2 rounds Workers allow
const PERSON = 'person:';
const FAILS = 'fails:';
export const FREE_WRONG = 10; // wrong passwords in a row before a name pauses
const PAUSE_MS = 60_000;
const MAX_PAUSE_MS = 15 * 60_000;
const LIST_CACHE_MS = 30_000;
const LOG_KEY = 'teacher-log';
const LOG_MAX = 25;
const SHARED_NAME = 'Shared key';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I to misread

interface Secret { salt: string; dk: string; it: number }
interface Person { id: string; name: string; ver: number; pw?: Secret; start?: Secret & { exp: number }; setAt?: number }
interface Meta { name: string; ready: boolean }
export interface Change { at: number; who: string; what: string }

export class AccountError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status; // not a parameter property, so Node's type stripping can load this file
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Same length in, constant time; different lengths are simply unequal (lengths are not secret here). */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, base, 256);
  return new Uint8Array(bits);
}

async function makeSecret(password: string): Promise<Secret> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: b64url(salt), dk: b64url(await derive(password, salt, ITERATIONS)), it: ITERATIONS };
}

async function matches(password: string, s: Secret | undefined): Promise<boolean> {
  if (!s) return false;
  return sameBytes(await derive(password, fromB64url(s.salt), s.it), fromB64url(s.dk));
}

const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** A start code like K7QD-M2PX-9FTA: 12 symbols from 32, about 60 bits. */
export function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const s = Array.from(bytes, (b) => CODE_ALPHABET[b % 32]).join('');
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

export function cleanName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (!/^[\p{L}][\p{L}0-9 .'-]{0,29}$/u.test(name)) throw new AccountError(400, 'A name is 1 to 30 letters (spaces, dots, dashes and apostrophes are fine).');
  return name;
}

export function idFor(name: string): string {
  return name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'teacher';
}

export function passwordProblem(password: unknown, name: string): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (password.length > MAX_PASSWORD) return `Use at most ${MAX_PASSWORD} characters.`;
  if (password.trim().toLowerCase() === name.toLowerCase()) return 'Your password cannot be your name.';
  return null;
}

function kv(env: TeacherEnv): KvLike {
  if (!env.TEACHERS_KV) throw new AccountError(503, 'Teacher accounts are not set up on this site yet.');
  return env.TEACHERS_KV;
}

async function readPerson(store: KvLike, id: string, cached = false): Promise<Person | null> {
  if (!/^[a-z0-9-]{1,30}$/.test(id)) return null;
  const p = (await store.get(PERSON + id, cached ? { type: 'json', cacheTtl: 30 } : { type: 'json' })) as Person | null;
  return p && typeof p === 'object' && p.id === id ? p : null;
}

async function writePerson(store: KvLike, p: Person): Promise<void> {
  const meta: Meta = { name: p.name, ready: !!p.pw };
  await store.put(PERSON + p.id, JSON.stringify(p), { metadata: meta });
  listCache = null;
}

/** The sign-in list (public): names only, never anything secret. */
export async function listPeople(env: TeacherEnv): Promise<{ id: string; name: string; ready: boolean }[]> {
  if (!env.TEACHERS_KV) return [];
  const out: { id: string; name: string; ready: boolean }[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const r = await env.TEACHERS_KV.list({ prefix: PERSON, cursor });
    for (const k of r.keys) {
      const m = k.metadata as Meta | undefined;
      if (m?.name) out.push({ id: k.name.slice(PERSON.length), name: m.name, ready: !!m.ready });
    }
    if (r.list_complete || !r.cursor) break;
    cursor = r.cursor;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// The public list, kept 30 s per isolate: anyone can ask for it, and every KV list is billed.
let listCache: { kv: KvLike | undefined; at: number; people: { id: string; name: string; ready: boolean }[] } | null = null;

/** What the public GET /api/teachers answers: who can sign in, and whether the old shared key still works. */
export async function signInOptions(env: TeacherEnv, now = Date.now()): Promise<{ people: { id: string; name: string; ready: boolean }[]; shared: boolean; accounts: boolean }> {
  if (!listCache || listCache.kv !== env.TEACHERS_KV || now - listCache.at > LIST_CACHE_MS || now < listCache.at) {
    listCache = { kv: env.TEACHERS_KV, at: now, people: await listPeople(env) };
  }
  return {
    people: listCache.people,
    shared: !!(env.TEACHER_KEY || env.TEACHER_KEY_2),
    accounts: !!(env.TEACHERS_KV && env.TEACHER_SESSION_KEY),
  };
}

// ---------- sessions ----------

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

interface TokenBody { i: string; v: number; e: number; s: 0 | 1 }

export async function mintToken(env: TeacherEnv, p: { id: string; ver: number }, setup: boolean, now: number): Promise<string> {
  if (!env.TEACHER_SESSION_KEY) throw new AccountError(503, 'Teacher accounts are not set up on this site yet.');
  const body: TokenBody = { i: p.id, v: p.ver, e: now + (setup ? SETUP_MINUTES * 60_000 : SESSION_DAYS * 86_400_000), s: setup ? 1 : 0 };
  const payload = b64url(enc.encode(JSON.stringify(body)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(env.TEACHER_SESSION_KEY), enc.encode(payload)));
  return `t1.${payload}.${b64url(sig)}`;
}

async function readToken(env: TeacherEnv, token: string, now: number): Promise<Who | null> {
  const [tag, payload, sig] = token.split('.');
  if (tag !== 't1' || !payload || !sig || !env.TEACHER_SESSION_KEY || !env.TEACHERS_KV) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(env.TEACHER_SESSION_KEY), fromB64url(sig) as BufferSource, enc.encode(payload));
  } catch {
    return null;
  }
  if (!ok) return null;
  let body: TokenBody;
  try {
    body = JSON.parse(dec.decode(fromB64url(payload)));
  } catch {
    return null;
  }
  if (typeof body.e !== 'number' || body.e <= now) return null;
  const p = await readPerson(env.TEACHERS_KV, String(body.i), true);
  // >=: a token minted a moment ago may be newer than the cached account; an older one is ended.
  if (!p || typeof body.v !== 'number' || body.v < p.ver) return null;
  return { id: p.id, name: p.name, via: 'account', setup: body.s === 1 };
}

async function sharedKeyMatches(env: TeacherEnv, given: string): Promise<boolean> {
  const keys = [env.TEACHER_KEY, env.TEACHER_KEY_2].filter((k): k is string => !!k);
  if (!keys.length || !given) return false;
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
  const g = await digest(given);
  let hit = false;
  for (const k of keys) hit = sameBytes(g, await digest(k)) || hit; // every key compared
  return hit;
}

async function checkPassword(env: TeacherEnv, c: PasswordCredential, now: number): Promise<Who | null> {
  const store = env.TEACHERS_KV;
  if (!store || typeof c.id !== 'string' || typeof c.password !== 'string' || c.password.length > MAX_PASSWORD) return null;
  const p = await readPerson(store, c.id);
  if (!p) {
    await derive(c.password, new Uint8Array(16), ITERATIONS); // same time as a real account
    return null;
  }
  // A paused name is refused before anything is compared, so a pause really stops guessing.
  const fails = ((await store.get(FAILS + p.id, { type: 'json' })) as { n: number; until: number } | null) ?? { n: 0, until: 0 };
  if (fails.until > now) {
    const min = Math.ceil((fails.until - now) / 60_000);
    throw new AccountError(429, `Too many wrong passwords for ${p.name}. Sign-in for ${p.name} is paused for ${min} minute${min === 1 ? '' : 's'}. A computer that is already signed in still works.`);
  }
  let who: Who | null = null;
  if (await matches(c.password, p.pw)) who = { id: p.id, name: p.name, via: 'account', setup: false };
  else if (p.start && p.start.exp > now && (await matches(normalizeCode(c.password), p.start))) {
    who = { id: p.id, name: p.name, via: 'account', setup: true };
  }
  try {
    if (who) {
      if (fails.n) await store.delete(FAILS + p.id);
    } else {
      const n = fails.n + 1;
      const until = n >= FREE_WRONG ? now + Math.min(MAX_PAUSE_MS, PAUSE_MS * 2 ** (n - FREE_WRONG)) : 0;
      await store.put(FAILS + p.id, JSON.stringify({ n, until }), { expirationTtl: 86_400 });
    }
  } catch (e) {
    console.error(JSON.stringify({ message: 'wrong-password count not saved', error: String(e) }));
  }
  return who;
}

/**
 * Who this is, or null for a wrong credential (the caller counts that as a wrong key).
 * A string is the x-teacher-key header: a session token, or the old shared key.
 */
export async function checkCredential(env: TeacherEnv, cred: string | PasswordCredential, now: number): Promise<Who | null> {
  if (typeof cred !== 'string') return checkPassword(env, cred, now);
  if (cred.startsWith('t1.')) return readToken(env, cred, now);
  return (await sharedKeyMatches(env, cred)) ? { id: 'shared', name: SHARED_NAME, via: 'shared', setup: false } : null;
}

/** A start-code session may only finish setting up. */
export function setupAllows(path: string): boolean {
  return path === '/api/teacher/signin' || path === '/api/teacher/me' || path === '/api/teacher/password';
}

/** The body of POST /api/teacher/signin, read before the gate. id "shared": the old shared key. */
export async function readSignIn(req: Request): Promise<string | PasswordCredential> {
  const b = (await readSmallJson(req)) as Partial<PasswordCredential>;
  const id = typeof b.id === 'string' ? b.id : '';
  const password = typeof b.password === 'string' ? b.password : '';
  return id === 'shared' ? password : { id, password };
}

async function readSmallJson(req: Request): Promise<Record<string, unknown>> {
  if (Number(req.headers.get('content-length') ?? 0) > 2048) throw new AccountError(413, 'That request is too large.');
  const text = await req.text();
  if (text.length > 2048) throw new AccountError(413, 'That request is too large.');
  try {
    const v = JSON.parse(text || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw new AccountError(400, 'The request was not valid JSON.');
  }
}

// ---------- change log (in each site's own KV) ----------

export async function logChange(siteKv: KvLike, who: Who, what: string, now: number): Promise<void> {
  try {
    const old = ((await siteKv.get(LOG_KEY, { type: 'json' })) as Change[] | null) ?? [];
    const list = [{ at: now, who: who.name, what }, ...(Array.isArray(old) ? old : [])].slice(0, LOG_MAX);
    await siteKv.put(LOG_KEY, JSON.stringify(list));
  } catch (e) {
    console.error(JSON.stringify({ message: 'teacher log not written', error: String(e) })); // never fail the change itself
  }
  console.log(JSON.stringify({ message: 'teacher change', who: who.name, what }));
}

export async function readChanges(siteKv: KvLike): Promise<Change[]> {
  const v = (await siteKv.get(LOG_KEY, { type: 'json' })) as Change[] | null;
  return Array.isArray(v) ? v : [];
}

// ---------- account routes ----------

const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/**
 * The account routes under /api/teacher/, AFTER the site's gate said who it is. `cred` is the same
 * credential the gate checked. Returns null for any other path. Errors come back as responses.
 */
export async function accountRoute(req: Request, path: string, env: TeacherEnv, siteKv: KvLike, who: Who, cred: string | PasswordCredential, now: number): Promise<Response | null> {
  try {
    return await route(req, path, env, siteKv, who, cred, now);
  } catch (e) {
    if (e instanceof AccountError) return reply({ error: e.message }, e.status);
    throw e;
  }
}

async function route(req: Request, path: string, env: TeacherEnv, siteKv: KvLike, who: Who, cred: string | PasswordCredential, now: number): Promise<Response | null> {
  const m = req.method;
  const me = { id: who.id, name: who.name, via: who.via, setup: who.setup };
  if (path === '/api/teacher/signin' && m === 'POST') {
    // A typed password becomes a session; a token or shared key just keeps working as it is.
    if (typeof cred !== 'string') {
      const p = await readPerson(kv(env), who.id);
      if (!p) throw new AccountError(401, 'Wrong teacher key.');
      return reply({ ...me, token: await mintToken(env, p, who.setup, now) });
    }
    return reply({ ...me, token: null });
  }
  if (path === '/api/teacher/me' && m === 'GET') return reply(me);
  if (path === '/api/teacher/changes' && m === 'GET') return reply({ changes: await readChanges(siteKv) });

  if (path === '/api/teacher/password' && m === 'POST') {
    if (who.via !== 'account') throw new AccountError(403, 'Sign in with your own name to set a password.');
    const store = kv(env);
    const b = await readSmallJson(req);
    const p = await readPerson(store, who.id);
    if (!p) throw new AccountError(401, 'Wrong teacher key.');
    if (!who.setup && !(await matches(typeof b.current === 'string' ? b.current : '', p.pw))) {
      throw new AccountError(400, 'Your current password is not right.');
    }
    const problem = passwordProblem(b.next, p.name);
    if (problem) throw new AccountError(400, problem);
    const next: Person = { id: p.id, name: p.name, ver: p.ver + 1, pw: await makeSecret(b.next as string), setAt: now };
    await writePerson(store, next);
    await logChange(siteKv, who, who.setup ? 'Chose their password' : 'Changed their password', now);
    return reply({ ...me, setup: false, token: await mintToken(env, next, false, now) });
  }

  if (path.startsWith('/api/teacher/people')) {
    const store = kv(env);
    if (who.setup) throw new AccountError(403, 'Choose your own password first.');
    const b = m === 'GET' ? {} : await readSmallJson(req);
    if (path === '/api/teacher/people' && m === 'GET') return reply({ people: await listPeople(env) });
    if (path === '/api/teacher/people' && m === 'POST') {
      const name = cleanName(b.name);
      const id = idFor(name);
      if (await readPerson(store, id)) throw new AccountError(409, `${name} already has an account.`);
      const code = newCode();
      await writePerson(store, { id, name, ver: 1, start: { ...(await makeSecret(normalizeCode(code))), exp: now + START_CODE_DAYS * 86_400_000 } });
      await logChange(siteKv, who, `Added ${name}`, now);
      return reply({ id, name, code, days: START_CODE_DAYS });
    }
    const p = await readPerson(store, typeof b.id === 'string' ? b.id : '');
    if (!p) throw new AccountError(404, 'There is no such teacher.');
    if (path === '/api/teacher/people/startcode' && m === 'POST') {
      // Their old password stops working and every session of theirs ends: the code is the only way in.
      // A teacher is helping on purpose, so a wrong-password pause on that name ends too.
      const code = newCode();
      await writePerson(store, { id: p.id, name: p.name, ver: p.ver + 1, start: { ...(await makeSecret(normalizeCode(code))), exp: now + START_CODE_DAYS * 86_400_000 } });
      await store.delete(FAILS + p.id);
      await logChange(siteKv, who, `Made a new start code for ${p.name}`, now);
      return reply({ id: p.id, name: p.name, code, days: START_CODE_DAYS });
    }
    if (path === '/api/teacher/people' && m === 'DELETE') {
      if (p.id === who.id) throw new AccountError(400, 'You cannot remove yourself. Ask another teacher.');
      await store.delete(PERSON + p.id);
      await store.delete(FAILS + p.id);
      listCache = null;
      await logChange(siteKv, who, `Removed ${p.name}`, now);
      return reply({ ok: true });
    }
  }
  return null;
}
