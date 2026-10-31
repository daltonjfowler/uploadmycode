// Teacher accounts (src/teachers.ts, the same file on all four sites): start code → own password →
// session; a new password or start code ends older sessions; the old shared key still works; a
// start-code session reaches only the account routes; passwords are never stored.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  accountRoute, checkCredential, logChange, mintToken, newCode, passwordProblem, readChanges, readSignIn, setupAllows, signInOptions,
} from '../src/teachers.ts';

/** An in-memory KV with metadata and list, like Cloudflare's. */
function memoryKv() {
  const m = new Map();
  return {
    m,
    async get(k) { return m.has(k) ? JSON.parse(m.get(k).value) : null; },
    async put(k, value, opts = {}) { m.set(k, { value, metadata: opts.metadata }); },
    async delete(k) { m.delete(k); },
    async list({ prefix }) {
      return { keys: [...m].filter(([k]) => k.startsWith(prefix)).map(([name, v]) => ({ name, metadata: v.metadata })), list_complete: true };
    },
  };
}

const NOW = Date.UTC(2026, 9, 30, 20);
const SHARED = 'old-shared-key-123';

function setup() {
  const env = { TEACHERS_KV: memoryKv(), TEACHER_SESSION_KEY: 'test-session-secret', TEACHER_KEY: SHARED };
  return { env, site: memoryKv() };
}

const req = (method, body) => new Request('https://x.test/', { method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });

/** Call an account route as `cred` (what the site gate checked), the way a Worker does. */
async function call(env, site, path, method, body, cred, now = NOW) {
  const who = await checkCredential(env, cred, now);
  assert.ok(who, `credential refused for ${path}`);
  const r = await accountRoute(req(method, body), path, env, site, who, cred, now);
  return { status: r.status, body: await r.json() };
}

async function addTeacher(env, site, name) {
  const r = await call(env, site, '/api/teacher/people', 'POST', { name }, SHARED);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

test('the old shared key still works, and its holder can add teachers', async () => {
  const { env, site } = setup();
  assert.deepEqual(await checkCredential(env, SHARED, NOW), { id: 'shared', name: 'Shared key', via: 'shared', setup: false });
  assert.equal(await checkCredential(env, 'wrong', NOW), null);
  const peter = await addTeacher(env, site, 'Peter');
  assert.equal(peter.id, 'peter');
  assert.match(peter.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.deepEqual((await signInOptions(env)).people, [{ id: 'peter', name: 'Peter', ready: false }]);
  assert.equal((await signInOptions(env)).shared, true);
});

test('start code → choose a password → a full session; the code then stops working', async () => {
  const { env, site } = setup();
  const { code } = await addTeacher(env, site, 'Axel');
  // typed in lower case with spaces: still the code
  const typed = { id: 'axel', password: code.toLowerCase().replace(/-/g, ' ') };
  const s = await call(env, site, '/api/teacher/signin', 'POST', null, typed);
  assert.equal(s.body.setup, true);
  assert.ok(s.body.token.startsWith('t1.'));
  const setupWho = await checkCredential(env, s.body.token, NOW);
  assert.equal(setupWho.setup, true);
  assert.equal(setupAllows('/api/teacher/phrase'), false);
  assert.equal(setupAllows('/api/teacher/password'), true);

  const tooShort = await call(env, site, '/api/teacher/password', 'POST', { next: 'short' }, s.body.token);
  assert.equal(tooShort.status, 400);
  const set = await call(env, site, '/api/teacher/password', 'POST', { next: 'my own long password' }, s.body.token);
  assert.equal(set.status, 200);
  assert.equal(set.body.setup, false);
  assert.equal((await checkCredential(env, set.body.token, NOW)).name, 'Axel');

  assert.equal(await checkCredential(env, typed, NOW), null, 'start code is used up');
  assert.equal(await checkCredential(env, s.body.token, NOW), null, 'the start-code session ended');
  assert.equal((await checkCredential(env, { id: 'axel', password: 'my own long password' }, NOW)).setup, false);
  assert.equal(await checkCredential(env, { id: 'axel', password: 'my own long passwordX' }, NOW), null);
  assert.deepEqual((await signInOptions(env)).people, [{ id: 'axel', name: 'Axel', ready: true }]);

  // the password itself is nowhere in storage
  const stored = [...env.TEACHERS_KV.m.values()].map((v) => v.value).join();
  assert.ok(!stored.includes('my own long password'));
  assert.ok(!stored.includes(code));
});

test('changing a password needs the current one and ends older sessions', async () => {
  const { env, site } = setup();
  const { code } = await addTeacher(env, site, 'Dalton');
  const first = await call(env, site, '/api/teacher/signin', 'POST', null, { id: 'dalton', password: code });
  const t1 = (await call(env, site, '/api/teacher/password', 'POST', { next: 'first password!!' }, first.body.token)).body.token;
  const wrongCurrent = await call(env, site, '/api/teacher/password', 'POST', { current: 'nope', next: 'second password!!' }, t1);
  assert.equal(wrongCurrent.status, 400);
  const t2 = (await call(env, site, '/api/teacher/password', 'POST', { current: 'first password!!', next: 'second password!!' }, t1)).body.token;
  assert.equal(await checkCredential(env, t1, NOW), null, 'the old session ended');
  assert.equal((await checkCredential(env, t2, NOW)).id, 'dalton');
  assert.match(passwordProblem('Dalton    ', 'dalton'), /cannot be your name/);
  assert.equal(passwordProblem('dalton', 'Dalton'), 'Use at least 10 characters.');
  assert.match(passwordProblem('Peter Smith', 'peter smith'), /cannot be your name/);
});

test('a new start code (forgot password) ends the old password and sessions', async () => {
  const { env, site } = setup();
  const { code } = await addTeacher(env, site, 'Peter');
  const s = await call(env, site, '/api/teacher/signin', 'POST', null, { id: 'peter', password: code });
  const token = (await call(env, site, '/api/teacher/password', 'POST', { next: 'peters password' }, s.body.token)).body.token;
  const again = await call(env, site, '/api/teacher/people/startcode', 'POST', { id: 'peter' }, SHARED);
  assert.equal(again.status, 200);
  assert.equal(await checkCredential(env, token, NOW), null);
  assert.equal(await checkCredential(env, { id: 'peter', password: 'peters password' }, NOW), null);
  assert.equal((await checkCredential(env, { id: 'peter', password: again.body.code }, NOW)).setup, true);
});

test('sessions and start codes expire; a forged or tampered token is refused', async () => {
  const { env, site } = setup();
  const { code } = await addTeacher(env, site, 'Peter');
  assert.equal((await checkCredential(env, { id: 'peter', password: code }, NOW + 20 * 86_400_000)).setup, true, 'a week off does not use it up');
  assert.equal(await checkCredential(env, { id: 'peter', password: code }, NOW + 22 * 86_400_000), null, 'start code lasts 21 days');
  const tok = await mintToken(env, { id: 'peter', ver: 1 }, false, NOW);
  assert.ok(await checkCredential(env, tok, NOW + 29 * 86_400_000));
  assert.equal(await checkCredential(env, tok, NOW + 31 * 86_400_000), null, 'sessions last 30 days');
  const [t, payload, sig] = tok.split('.');
  const evil = Buffer.from(JSON.stringify({ i: 'peter', v: 99, e: NOW * 2, s: 0 })).toString('base64url');
  assert.equal(await checkCredential(env, `${t}.${evil}.${sig}`, NOW), null);
  assert.equal(await checkCredential({ ...env, TEACHER_SESSION_KEY: 'other site' }, tok, NOW), null);
  assert.equal(await checkCredential(env, `${t}.${payload}.`, NOW), null);
  const setupTok = await mintToken(env, { id: 'peter', ver: 1 }, true, NOW);
  assert.equal(await checkCredential(env, setupTok, NOW + 31 * 60_000), null, 'a start-code session lasts 30 minutes');
});

test('teachers can remove each other but not themselves; unknown names are refused', async () => {
  const { env, site } = setup();
  const { code } = await addTeacher(env, site, 'Dalton');
  await addTeacher(env, site, 'Axel');
  const dup = await call(env, site, '/api/teacher/people', 'POST', { name: 'axel' }, SHARED);
  assert.equal(dup.status, 409);
  const bad = await call(env, site, '/api/teacher/people', 'POST', { name: '<script>' }, SHARED);
  assert.equal(bad.status, 400);
  const s = await call(env, site, '/api/teacher/signin', 'POST', null, { id: 'dalton', password: code });
  const t = (await call(env, site, '/api/teacher/password', 'POST', { next: 'daltons password' }, s.body.token)).body.token;
  assert.equal((await call(env, site, '/api/teacher/people', 'DELETE', { id: 'dalton' }, t)).status, 400);
  assert.equal((await call(env, site, '/api/teacher/people', 'DELETE', { id: 'axel' }, t)).status, 200);
  assert.deepEqual((await signInOptions(env)).people.map((p) => p.id), ['dalton']);
  assert.equal(await checkCredential(env, { id: 'nobody', password: 'whatever12345' }, NOW), null);
  assert.equal((await call(env, site, '/api/teacher/people/startcode', 'POST', { id: 'nobody' }, t)).status, 404);
});

test('10 wrong passwords pause that name (growing), even for the right password; sessions keep working', async () => {
  const { env, site } = setup();
  const { code } = await addTeacher(env, site, 'Peter');
  const s = await call(env, site, '/api/teacher/signin', 'POST', null, { id: 'peter', password: code });
  const token = (await call(env, site, '/api/teacher/password', 'POST', { next: 'peters password' }, s.body.token)).body.token;
  const right = { id: 'peter', password: 'peters password' };
  const wrong = { id: 'peter', password: 'not peters password' };
  // a right password clears the count
  for (let i = 0; i < 9; i++) assert.equal(await checkCredential(env, wrong, NOW), null);
  assert.ok(await checkCredential(env, right, NOW));
  for (let i = 0; i < 10; i++) assert.equal(await checkCredential(env, wrong, NOW), null);
  await assert.rejects(checkCredential(env, right, NOW), (e) => e.status === 429 && /paused for 1 minute/.test(e.message));
  assert.ok(await checkCredential(env, token, NOW), 'a signed-in computer still works');
  // after the pause one more wrong pauses it for 2 minutes
  const later = NOW + 61_000;
  assert.equal(await checkCredential(env, wrong, later), null);
  await assert.rejects(checkCredential(env, right, later + 60_000), (e) => /paused for 1 minute/.test(e.message));
  assert.ok(await checkCredential(env, right, later + 121_000), 'the pause ends');
  // another teacher's start code ends a pause at once
  for (let i = 0; i < 10; i++) await checkCredential(env, wrong, later + 200_000);
  const fresh = await call(env, site, '/api/teacher/people/startcode', 'POST', { id: 'peter' }, SHARED, later + 200_000);
  assert.equal((await checkCredential(env, { id: 'peter', password: fresh.body.code }, later + 200_000)).setup, true);
  // other names are not paused
  const { code: axel } = await addTeacher(env, site, 'Axel');
  assert.equal((await checkCredential(env, { id: 'axel', password: axel }, NOW)).setup, true);
});

test('a start-code session cannot manage accounts', async () => {
  const { env, site } = setup();
  const { code } = await addTeacher(env, site, 'Axel');
  const s = await call(env, site, '/api/teacher/signin', 'POST', null, { id: 'axel', password: code });
  assert.equal((await call(env, site, '/api/teacher/people', 'POST', { name: 'Eve' }, s.body.token)).status, 403);
});

test('the change list keeps the newest 25 with names', async () => {
  const site = memoryKv();
  const who = { id: 'peter', name: 'Peter', via: 'account', setup: false };
  for (let i = 0; i < 30; i++) await logChange(site, who, `change ${i}`, NOW + i);
  const list = await readChanges(site);
  assert.equal(list.length, 25);
  assert.deepEqual(list[0], { at: NOW + 29, who: 'Peter', what: 'change 29' });
});

test('sign-in body: a name and password, or the old shared key', async () => {
  assert.deepEqual(await readSignIn(req('POST', { id: 'peter', password: 'pw' })), { id: 'peter', password: 'pw' });
  assert.equal(await readSignIn(req('POST', { id: 'shared', password: SHARED })), SHARED);
  assert.match(newCode(), /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
});

test('no accounts set up: only the shared key, and the page is told', async () => {
  const env = { TEACHER_KEY: SHARED };
  assert.deepEqual(await signInOptions(env), { people: [], shared: true, accounts: false });
  assert.equal(await checkCredential(env, { id: 'peter', password: 'x'.repeat(12) }, NOW), null);
  assert.equal(await checkCredential(env, 't1.abc.def', NOW), null);
});
