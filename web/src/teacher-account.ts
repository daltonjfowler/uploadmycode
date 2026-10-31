// Teacher sign-in on the teacher page, the same file on all four uploadmy sites (laser, model, code, cut;
// the server half is src/teachers.ts). Pick your name, type your password. A new teacher types the start
// code another teacher gave them, then chooses their own password. Signed in, it shows who you are, the
// teacher accounts (start codes, add, remove) and the recent changes with who made them.
//
// The session (or, during the switch, the old shared key) is kept in localStorage under `storageKey` and
// sent as x-teacher-key, the header every teacher call already used.
import './teacher-account.css';

export interface AccountOptions {
  root: HTMLElement;
  storageKey: string;
  headers?: () => Record<string, string>; // e.g. the device id the lockout counts by
  onSignedIn: () => void; // signed in with a password chosen: load the rest of the teacher page
  onSignedOut: () => void;
}

export interface Account {
  /** What to send as x-teacher-key ('' when signed out). */
  credential(): string;
  /** The server refused the credential (401): sign in again. */
  refused(): void;
  /** Reload the recent changes (call after saving something). */
  refreshChanges(): void;
}

interface Person { id: string; name: string; ready: boolean }
interface Me { id: string; name: string; via: 'account' | 'shared'; setup: boolean; token?: string | null }
interface Change { at: number; who: string; what: string }

const MIN_PASSWORD = 10;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const { class: cls, ...rest } = props;
  const e = Object.assign(document.createElement(tag), rest);
  if (cls) e.className = cls;
  e.append(...kids);
  return e;
}

function when(ms: number): string {
  try {
    return new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

export function mountAccount(o: AccountOptions): Account {
  let cred = '';
  try { cred = localStorage.getItem(o.storageKey) ?? ''; } catch { /* storage blocked: this tab only */ }
  let me: Me | null = null;
  let changesBox: HTMLElement | null = null;
  let peopleDrawn = 0;

  const save = (c: string) => {
    cred = c;
    try {
      if (c) localStorage.setItem(o.storageKey, c);
      else localStorage.removeItem(o.storageKey);
    } catch { /* this tab only */ }
  };

  async function call<T>(path: string, method = 'GET', body?: unknown, useCred = true): Promise<{ status: number; data: T & { error?: string; message?: string } }> {
    const r = await fetch(path, {
      method,
      headers: {
        ...(o.headers?.() ?? {}),
        ...(useCred && cred ? { 'x-teacher-key': cred } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }

  const errorText = (status: number, d: { error?: string; message?: string }) =>
    status === 429 && d.message ? d.message : d.error ?? `Something went wrong (${status}).`;

  const msg = h('p', { class: 'ta-msg' });
  const say = (text: string, tone: 'plain' | 'ok' | 'error' = 'plain') => {
    msg.textContent = text;
    msg.dataset.tone = tone;
  };

  // ---------- signed out ----------

  async function showSignIn(note = ''): Promise<void> {
    me = null;
    o.onSignedOut();
    const who = h('select', { id: 'taWho', name: 'username', autocomplete: 'username' });
    const pw = h('input', { id: 'taPassword', type: 'password', name: 'password', autocomplete: 'current-password', placeholder: 'password or start code' });
    const go = h('button', { type: 'submit', class: 'primary' }, 'Sign in');
    const form = h('form', { class: 'ta-form' },
      h('label', {}, h('span', {}, 'Who are you?'), who),
      h('label', {}, h('span', {}, 'Password'), pw),
      go);
    const help = h('p', { class: 'ta-note' });
    o.root.replaceChildren(form, help, msg);
    say(note, note ? 'error' : 'plain');

    let opts: { people: Person[]; shared: boolean; accounts: boolean };
    try {
      const r = await call<typeof opts>('/api/teachers', 'GET', undefined, false);
      if (r.status !== 200) throw new Error();
      opts = r.data;
    } catch {
      say('Could not reach the server. Check the network, then reload the page.', 'error');
      return;
    }
    for (const p of opts.people) who.add(new Option(p.name, p.id));
    if (opts.shared) who.add(new Option(opts.people.length ? 'Old shared key' : 'Shared key', 'shared'));
    if (!who.options.length) {
      help.textContent = 'Teacher sign-in is not set up on this site yet.';
      go.disabled = true;
      return;
    }
    help.textContent = !opts.people.length
      ? 'No teacher accounts yet. Sign in with the shared key, then add each teacher under Teacher accounts.'
      : 'New here, or forgot your password? Ask another teacher for a start code, then type it as your password.';
    try {
      const last = localStorage.getItem(`${o.storageKey}.who`);
      if (last && [...who.options].some((x) => x.value === last)) who.value = last;
    } catch { /* fine */ }
    pw.focus();

    form.onsubmit = async (e) => {
      e.preventDefault();
      if (!pw.value) return say('Type your password.', 'error');
      go.disabled = true;
      say('Signing in…');
      try {
        const r = await call<Me>('/api/teacher/signin', 'POST', { id: who.value, password: pw.value }, false);
        if (r.status === 401) return say(who.value === 'shared'
          ? 'That shared key is not right.'
          : 'That password is not right. (A start code made in the last minute can take a minute to start working.)', 'error');
        if (r.status !== 200) return say(errorText(r.status, r.data), 'error');
        try { localStorage.setItem(`${o.storageKey}.who`, who.value); } catch { /* fine */ }
        save(r.data.token ?? pw.value); // the old shared key has no session: it is kept as it is
        offerToSave(who.value, pw.value, r.data);
        signedIn(r.data);
      } catch {
        say('Could not reach the server. Check the network.', 'error');
      } finally {
        go.disabled = false;
      }
    };
  }

  /** Chrome and Edge offer "Save password?" for a real password (not for a one-time start code). */
  function offerToSave(id: string, password: string, m: Me): void {
    const PC = (window as unknown as { PasswordCredential?: new (d: { id: string; password: string; name: string }) => Credential }).PasswordCredential;
    if (!PC || !navigator.credentials?.store || m.setup) return;
    navigator.credentials.store(new PC({ id, password, name: m.name })).catch(() => { /* declined */ });
  }

  // ---------- choose a password (after a start code) ----------

  function showSetup(m: Me): void {
    o.onSignedOut();
    const a = h('input', { type: 'password', autocomplete: 'new-password', placeholder: `at least ${MIN_PASSWORD} characters` });
    const b = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'the same again' });
    const go = h('button', { type: 'submit', class: 'primary' }, 'Save my password');
    const user = h('input', { type: 'text', name: 'username', autocomplete: 'username', value: m.id, hidden: true });
    const form = h('form', { class: 'ta-form' }, user,
      h('label', {}, h('span', {}, 'New password'), a),
      h('label', {}, h('span', {}, 'Type it again'), b),
      go);
    o.root.replaceChildren(
      h('p', { class: 'ta-hello' }, `Hi ${m.name}. Choose your own password. It works on all four uploadmy sites, and nobody else ever sees it.`),
      form, msg);
    say('');
    a.focus();
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (a.value.length < MIN_PASSWORD) return say(`Use at least ${MIN_PASSWORD} characters.`, 'error');
      if (a.value !== b.value) return say('The two passwords are not the same.', 'error');
      go.disabled = true;
      try {
        const r = await call<Me>('/api/teacher/password', 'POST', { next: a.value });
        if (r.status === 401) return refused();
        if (r.status !== 200) return say(errorText(r.status, r.data), 'error');
        save(r.data.token ?? '');
        offerToSave(m.id, a.value, r.data);
        signedIn(r.data, 'Password saved. You are signed in.');
      } catch {
        say('Could not reach the server. Check the network.', 'error');
      } finally {
        go.disabled = false;
      }
    };
  }

  // ---------- signed in ----------

  function signedIn(m: Me, note = ''): void {
    if (m.setup) return showSetup(m);
    me = m;
    const change = h('button', { type: 'button' }, 'Change my password');
    const out = h('button', { type: 'button' }, 'Sign out');
    const bar = h('div', { class: 'ta-bar' },
      m.via === 'shared'
        ? h('p', { class: 'ta-who' }, 'Signed in with the ', h('strong', {}, 'old shared key'))
        : h('p', { class: 'ta-who' }, 'Signed in as ', h('strong', {}, m.name)),
      ...(m.via === 'account' ? [change] : []), out);
    const pwBox = h('div', { class: 'ta-sub', hidden: true });
    const people = h('details', { class: 'ta-details' }, h('summary', {}, 'Teacher accounts'));
    changesBox = h('ol', { class: 'ta-changes' });
    const changes = h('details', { class: 'ta-details', open: true }, h('summary', {}, 'Recent changes'), changesBox);
    o.root.replaceChildren(bar, pwBox, msg, people, changes);
    say(m.via === 'shared'
      ? 'You used the old shared key. Open Teacher accounts to add each teacher; they then choose their own passwords.'
      : note, m.via === 'shared' ? 'plain' : 'ok');
    if (m.via === 'shared') people.open = true;

    out.onclick = () => {
      save('');
      void showSignIn();
    };
    change.onclick = () => {
      if (!pwBox.hidden) {
        pwBox.hidden = true;
        return;
      }
      const cur = h('input', { type: 'password', autocomplete: 'current-password' });
      const a = h('input', { type: 'password', autocomplete: 'new-password', placeholder: `at least ${MIN_PASSWORD} characters` });
      const b = h('input', { type: 'password', autocomplete: 'new-password' });
      const go = h('button', { type: 'submit', class: 'primary' }, 'Save new password');
      const form = h('form', { class: 'ta-form' },
        h('input', { type: 'text', name: 'username', autocomplete: 'username', value: m.id, hidden: true }),
        h('label', {}, h('span', {}, 'Current password'), cur),
        h('label', {}, h('span', {}, 'New password'), a),
        h('label', {}, h('span', {}, 'Type it again'), b),
        go);
      pwBox.replaceChildren(form, h('p', { class: 'ta-note' }, 'Your other computers will need to sign in again.'));
      pwBox.hidden = false;
      cur.focus();
      form.onsubmit = async (e) => {
        e.preventDefault();
        if (a.value.length < MIN_PASSWORD) return say(`Use at least ${MIN_PASSWORD} characters.`, 'error');
        if (a.value !== b.value) return say('The two new passwords are not the same.', 'error');
        go.disabled = true;
        try {
          const r = await call<Me>('/api/teacher/password', 'POST', { current: cur.value, next: a.value });
          if (r.status === 401) return refused();
          if (r.status !== 200) return say(errorText(r.status, r.data), 'error');
          save(r.data.token ?? '');
          offerToSave(m.id, a.value, r.data);
          pwBox.hidden = true;
          say('Password changed.', 'ok');
          refreshChanges();
        } catch {
          say('Could not reach the server. Check the network.', 'error');
        } finally {
          go.disabled = false;
        }
      };
    };

    // Opened in code above too: the toggle event for that comes later, so this one listener draws it once.
    people.addEventListener('toggle', () => { if (people.open) void renderPeople(people); });
    refreshChanges();
    o.onSignedIn();
  }

  /** `made`: a start code just made, kept on screen above the redrawn list until the teacher has copied it. */
  async function renderPeople(box: HTMLDetailsElement, made?: { name: string; code: string; days: number }): Promise<void> {
    const summary = box.querySelector('summary')!;
    const list = h('ul', { class: 'ta-people' });
    const shown = h('div', { class: 'ta-code', hidden: true });
    const name = h('input', { type: 'text', placeholder: 'First name', autocomplete: 'off', maxLength: 30 });
    const add = h('button', { type: 'submit' }, 'Add teacher');
    const addForm = h('form', { class: 'ta-form ta-add' }, h('label', {}, h('span', {}, 'Add a teacher'), name), add);
    box.replaceChildren(summary, list, shown, addForm,
      h('p', { class: 'ta-note' }, 'Every teacher can do everything here. A start code works once, for 7 days, and ends that teacher\'s old password.'));

    const showCode = (who: string, code: string, days: number) => {
      shown.replaceChildren(
        h('p', {}, `Start code for ${who}: `, h('strong', { class: 'ta-codetext' }, code)),
        h('p', { class: 'ta-note' }, `Give it to ${who} in person. On this teacher page (or any uploadmy site's), ${who} picks their name, types the code as the password, then chooses their own password. It works once, for ${days} days.`));
      shown.hidden = false;
    };
    if (made) showCode(made.name, made.code, made.days);

    // Wired before the list loads: a quick click must never reach a form with no handler (a page reload).
    addForm.onsubmit = async (e) => {
      e.preventDefault();
      if (!name.value.trim()) return say('Type the teacher\'s first name.', 'error');
      add.disabled = true;
      try {
        const c = await call<{ code: string; name: string; days: number }>('/api/teacher/people', 'POST', { name: name.value });
        if (c.status === 401) return refused();
        if (c.status !== 200) return say(errorText(c.status, c.data), 'error');
        say(`${c.data.name} was added.`, 'ok');
        refreshChanges();
        await renderPeople(box, c.data);
      } catch {
        say('Could not reach the server. Check the network.', 'error');
      } finally {
        add.disabled = false;
      }
    };

    const gen = ++peopleDrawn;
    const r = await call<{ people: Person[] }>('/api/teacher/people').catch(() => null);
    if (gen !== peopleDrawn) return; // a newer draw is on its way
    if (!r) {
      list.replaceChildren(h('li', {}, 'Could not reach the server. Check the network.'));
      return;
    }
    if (r.status === 401) return refused();
    if (r.status !== 200) {
      list.replaceChildren(h('li', {}, errorText(r.status, r.data)));
      return;
    }
    list.replaceChildren(...r.data.people.map((p) => {
      const code = h('button', { type: 'button' }, p.ready ? 'New start code' : 'Make start code');
      const remove = h('button', { type: 'button', class: 'ta-quiet' }, 'Remove');
      code.onclick = async () => {
        if (p.ready && !confirm(`Make a new start code for ${p.name}?\n\n${p.name}'s password stops working now, and they are signed out everywhere until they use the code.`)) return;
        const c = await call<{ code: string; name: string; days: number }>('/api/teacher/people/startcode', 'POST', { id: p.id });
        if (c.status === 401) return refused();
        if (c.status !== 200) return say(errorText(c.status, c.data), 'error');
        refreshChanges();
        void renderPeople(box, c.data);
      };
      remove.onclick = async () => {
        if (!confirm(`Remove ${p.name}? They can no longer sign in on any uploadmy site.`)) return;
        const c = await call('/api/teacher/people', 'DELETE', { id: p.id });
        if (c.status === 401) return refused();
        if (c.status !== 200) return say(errorText(c.status, c.data), 'error');
        say(`${p.name} was removed.`, 'ok');
        refreshChanges();
        void renderPeople(box);
      };
      const mine = me?.via === 'account' && me.id === p.id;
      return h('li', {},
        h('span', { class: 'ta-pname' }, p.name + (mine ? ' (you)' : '')),
        h('span', { class: 'ta-pstate' }, p.ready ? 'password set' : 'waiting for their start code'),
        ...(mine ? [] : [code, remove]));
    }));
    if (!r.data.people.length) list.replaceChildren(h('li', { class: 'ta-note' }, 'No teacher accounts yet. Add yourself first.'));
  }

  function refreshChanges(): void {
    const box = changesBox;
    if (!box || !me) return;
    void call<{ changes: Change[] }>('/api/teacher/changes').then((r) => {
      if (r.status === 401) return refused();
      if (r.status !== 200) return;
      const items = r.data.changes.slice(0, 8).map((c) => h('li', {}, h('span', { class: 'ta-when' }, when(c.at)), ' ', h('strong', {}, c.who), ` ${c.what.charAt(0).toLowerCase()}${c.what.slice(1)}`));
      box.replaceChildren(...(items.length ? items : [h('li', { class: 'ta-note' }, 'Nothing changed yet.')]));
    }).catch(() => { /* next time */ });
  }

  function refused(): void {
    if (!cred && !me) return;
    save('');
    void showSignIn('Your sign-in ended (a new password, a start code, or 30 days). Sign in again.');
  }

  // ---------- start ----------

  (async () => {
    if (!cred) return showSignIn();
    o.root.replaceChildren(h('p', { class: 'ta-note' }, 'Checking your sign-in…'));
    try {
      const r = await call<Me>('/api/teacher/me');
      if (r.status === 200) return signedIn(r.data);
      if (r.status === 401 || r.status === 403) {
        save('');
        return showSignIn(cred.startsWith('t1.') ? 'Your sign-in ended. Sign in again.' : 'The saved teacher key no longer works. Sign in with your name.');
      }
      return showSignIn(errorText(r.status, r.data));
    } catch {
      return showSignIn('Could not reach the server. Check the network, then reload the page.');
    }
  })();

  return { credential: () => cred, refused, refreshChanges };
}
