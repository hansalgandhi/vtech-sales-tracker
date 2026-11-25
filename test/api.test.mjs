// End-to-end API checks against a local worker. Start it first:
//   npx wrangler dev --port 8799 --var ADMIN_EMAIL:admin@test.local
// then: npm test
import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE ?? 'http://localhost:8799';
const PW = 'local-test-password';
const run = Math.random().toString(36).slice(2, 8); // keeps SKUs and emails unique across runs on the same local database
const today = new Date(Date.now() + 330 * 6e4).toISOString().slice(0, 10);

function client() {
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(`${BASE}/api/${path}`, { method, headers: { 'content-type': 'application/json', cookie, ...headers }, body: body && JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  return { del: (p) => call('DELETE', p), get: (p) => call('GET', p), post: (p, b, h) => call('POST', p, b, h), patch: (p, b) => call('PATCH', p, b) };
}
const ok = async (p) => { const r = await p; assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };

const admin = client(), rep = client(), rep2 = client();
const repEmail = `rep-${run}@test.local`, rep2Email = `rep2-${run}@test.local`;
let A, B, leadId;

test('setup, sign-in and access control', async () => {
  assert.equal((await client().get('me')).status, 401);
  if ((await ok(admin.get('needs-setup'))).needsSetup) {
    assert.equal((await admin.post('setup', { email: 'intruder@test.local', name: 'X', password: PW })).status, 403);
    await ok(admin.post('setup', { email: 'admin@test.local', name: 'Admin', password: PW }));
  }
  await ok(admin.post('login', { email: 'admin@test.local', password: PW }));
  assert.equal((await admin.post('logout', {}, { origin: 'https://evil.example' })).status, 403, 'cross-site writes are refused');
  await ok(admin.post('users', { email: repEmail, name: 'Rep One', password: PW, max_discount_pct: 5 }));
  await ok(admin.post('users', { email: rep2Email, name: 'Rep Two', password: PW }));
  await ok(rep.post('login', { email: repEmail, password: PW }));
  await ok(rep2.post('login', { email: rep2Email, password: PW }));
  assert.equal((await ok(rep.get('me'))).max_discount_pct, 5);
  assert.equal((await rep.get('users')).status, 403);
  const repId = (await ok(admin.get('users'))).find((u) => u.email === repEmail).id;
  assert.equal((await rep.patch('users/' + repId, { max_discount_pct: 90, role: 'admin' })).status, 403, 'a salesperson cannot raise their own limit');
});

test('central price list: admin-only, every change logged', async () => {
  await ok(admin.post('products', { sku: `KP-${run}`, name: 'Keypad', brand: 'Crestron', unit_price: 10000, max_discount_pct: 15 }));
  await ok(admin.post('products', { sku: `TP-${run}`, name: 'Touch panel', unit_price: 80000, max_discount_pct: 10 }));
  assert.equal((await admin.post('products', { sku: `KP-${run}`, name: 'Dup', unit_price: 1 })).status, 409);
  const list = await ok(rep.get('products'));
  A = list.find((p) => p.sku === `KP-${run}`); B = list.find((p) => p.sku === `TP-${run}`);
  assert.equal((await rep.patch('products/' + A.id, { unit_price: 1 })).status, 403);
  assert.equal((await rep.post('products/import', { rows: [{ sku: 'X', name: 'X', unit_price: 1 }] })).status, 403);
  await ok(admin.patch('products/' + A.id, { unit_price: 11000 }));
  await ok(admin.patch('products/' + A.id, { name: 'Keypad 6-button' })); // not a price change, must not be logged
  const hist = await ok(rep.get(`products/${A.id}/history`));
  assert.deepEqual(hist.map((h) => [h.old_price, h.new_price]), [[10000, 11000], [null, 10000]]);
});

test('spreadsheet import adds and updates by SKU', async () => {
  const r = await ok(admin.post('products/import', { rows: [{ sku: `tp-${run}`, unit_price: '82000' }, { sku: `AMP-${run}`, name: 'Amplifier', unit_price: '45000', max_discount_pct: '8' }] }));
  assert.deepEqual(r, { created: 1, updated: 1 });
  const list = await ok(admin.get('products'));
  B = list.find((p) => p.id === B.id);
  assert.equal(B.unit_price, 82000); assert.equal(B.name, 'Touch panel'); assert.equal(B.max_discount_pct, 10);
  assert.equal((await ok(admin.get(`products/${B.id}/history`)))[0].old_price, 80000);
  assert.equal((await admin.post('products/import', { rows: [{ sku: 'D1', name: 'a', unit_price: 1 }, { sku: 'd1', name: 'b', unit_price: 2 }] })).status, 400);
  assert.equal((await admin.post('products/import', { rows: [{ sku: 'NOPRICE', name: 'a' }] })).status, 400);
});

test('leads: requirements, owner-only visibility, interactions and follow-ups', async () => {
  leadId = (await ok(rep.post('leads', { company: `Bandra 3BHK ${run}`, contact: 'Mr A', source: 'architect', requirements: 'Lights + curtains in 3 rooms' }))).id;
  assert.equal((await rep2.get('leads/' + leadId)).status, 404);
  assert.equal((await rep.post(`leads/${leadId}/interactions`, { kind: 'call' })).status, 400, 'an interaction needs a note');
  await ok(rep.post(`leads/${leadId}/interactions`, { kind: 'site_visit', note: 'Measured living room', next_followup: today, stage: 'site_visit' }));
  const row = (await ok(rep.get('leads?q=' + run))).find((l) => l.id === leadId);
  assert.equal(row.requirements, 'Lights + curtains in 3 rooms');
  assert.deepEqual([row.last_kind, row.last_note, row.next_followup, row.stage, row.boq_count], ['site_visit', 'Measured living room', today, 'site_visit', 0]);
  assert.ok((await ok(rep.get('leads?due=1'))).some((l) => l.id === leadId));
  assert.ok(!(await ok(rep.get('leads?stale=1'))).some((l) => l.id === leadId));
  assert.ok(!(await ok(rep2.get('leads'))).some((l) => l.id === leadId));
  assert.ok((await ok(admin.get('leads?q=' + run))).some((l) => l.id === leadId && l.owner_name === 'Rep One'));
});

test('BOQs: list prices only, discount limits, admin approval', async () => {
  assert.equal((await rep.post(`leads/${leadId}/boqs`, { lines: [{ description: 'Off-list', unit_price: 5, qty: 1 }] })).status, 400);
  // within the 5% personal limit; the client-supplied unit_price must be ignored
  const b1 = await ok(rep.post(`leads/${leadId}/boqs`, { lines: [{ product_id: A.id, qty: 4, discount_pct: 5, unit_price: 1 }, { product_id: B.id, qty: 1 }] }));
  assert.equal(b1.status, 'issued'); assert.equal(b1.total, 4 * 11000 * 0.95 + 82000);
  assert.equal((await ok(rep.get('leads/' + leadId))).stage, 'boq_sent');
  // 12% is under the product's 15% but over the salesperson's 5%
  const b2 = await ok(rep.post(`leads/${leadId}/boqs`, { lines: [{ product_id: A.id, qty: 2, discount_pct: 12 }], note: 'Competing quote' }));
  assert.equal(b2.status, 'pending_approval');
  assert.equal((await ok(rep.get('leads?q=' + run))).find((l) => l.id === leadId).boq_count, 1, 'a pending BOQ does not count as sent');
  assert.equal((await rep.patch('boqs/' + b2.id, { status: 'issued' })).status, 403);
  assert.equal((await rep2.get('boqs/' + b2.id)).status, 404);
  const pending = (await ok(admin.get('boqs?status=pending_approval'))).find((b) => b.id === b2.id);
  assert.equal(pending.over_lines, 1); assert.equal(pending.note, 'Competing quote');
  assert.ok((await ok(admin.get('dashboard'))).pending >= 1);
  await ok(admin.patch('boqs/' + b2.id, { status: 'issued', decision_note: 'ok this once' }));
  const row = (await ok(rep.get('leads?q=' + run))).find((l) => l.id === leadId);
  assert.deepEqual([row.boq_count, row.last_boq_total, row.last_boq_ref], [2, 2 * 11000 * 0.88, b2.ref]);
  // a later price change must not rewrite what was already sent
  await ok(admin.patch('products/' + A.id, { unit_price: 99999 }));
  const sent = await ok(rep.get('boqs/' + b2.id));
  assert.deepEqual([sent.lines[0].unit_price, sent.lines[0].cap_pct, sent.total, sent.lead.company], [11000, 5, 2 * 11000 * 0.88, `Bandra 3BHK ${run}`]);
  const quoted = (await ok(rep.get('leads/' + leadId))).quoted.find((q) => q.product_id === A.id);
  assert.deepEqual([quoted.unit_price, quoted.discount_pct], [11000, 12], 'the lead shows the price last sent');
  await ok(rep.patch('boqs/' + b1.id, { status: 'accepted' }));
  assert.equal((await rep.patch('boqs/' + b1.id, { status: 'pending_approval' })).status, 400);
  assert.ok(!(await ok(rep2.get('boqs'))).some((b) => b.lead_id === leadId));
  const d = await ok(rep.get('dashboard'));
  assert.equal(d.boq_n, 2); assert.equal(d.due, 1); assert.equal(d.byOwner.length, 1);
  // admins have no limit and may add off-list items
  assert.equal((await ok(admin.post(`leads/${leadId}/boqs`, { lines: [{ product_id: B.id, qty: 1, discount_pct: 40 }, { description: 'Site labour', unit_price: 5000, qty: 1 }] }))).status, 'issued');
});

test('accounts: password change, last-admin guard, login lockout, reminders', async () => {
  assert.equal((await rep.post('me/password', { current: 'wrong', password: 'another-password-1' })).status, 400);
  await ok(rep.post('me/password', { current: PW, password: 'another-password-1' }));
  assert.equal((await rep.get('me')).status, 401, 'old sessions end on password change');
  await ok(rep.post('login', { email: repEmail, password: 'another-password-1' }));
  const me = await ok(admin.get('me'));
  const admins = (await ok(admin.get('users'))).filter((u) => u.role === 'admin' && u.active);
  if (admins.length === 1) assert.equal((await admin.patch('users/' + me.id, { role: 'member' })).status, 400);
  const r = await ok(admin.post('send-reminders'));
  assert.ok(r.users >= 1);
  const locked = client();
  for (let i = 0; i < 5; i++) assert.equal((await locked.post('login', { email: rep2Email, password: 'nope' })).status, 401);
  assert.equal((await locked.post('login', { email: rep2Email, password: PW })).status, 429);
});

test('sample data loads, behaves like real data, and removes cleanly', async () => {
  assert.equal((await rep.post('demo')).status, 403);
  const count = async () => [(await ok(admin.get('leads'))).length, (await ok(admin.get('products'))).length, (await ok(admin.get('users'))).length, (await ok(admin.get('boqs'))).length];
  const before = await count();
  const r = await ok(admin.post('demo'));
  assert.equal((await admin.post('demo')).status, 409, 'cannot be loaded twice');
  const after = await count();
  assert.deepEqual(after.map((n, i) => n - before[i]), [18, 30, 4, 13]);
  const demoRep = client();
  await ok(demoRep.post('login', { email: r.logins[0], password: r.password }));
  const mine = await ok(demoRep.get('leads'));
  assert.ok(mine.length >= 4 && mine.every((l) => l.owner_name === 'Rohan Mehta' && l.last_at));
  const d = await ok(admin.get('dashboard'));
  assert.ok(d.pending >= 2 && d.stale >= 2 && d.due >= 4 && d.boq_n >= 7);
  const pend = (await ok(admin.get('boqs?status=pending_approval'))).filter((b) => /-S\d\d$/.test(b.ref));
  assert.deepEqual(pend.map((b) => b.over_lines), [1, 1]);
  const orchid = (await ok(admin.get('leads?q=Orchid')))[0];
  assert.equal(orchid.boq_count, 2);
  const quoted = (await ok(admin.get('leads/' + orchid.id))).quoted;
  assert.deepEqual(quoted.filter((q) => q.unit_price === 138000).length, 1, 'the older BOQ carries the price before the change');
  // a real lead created by a sample salesperson during a demo goes when the sample data goes
  await ok(demoRep.post('leads', { company: 'Made during demo' }));
  await ok(admin.del('demo'));
  assert.deepEqual(await count(), before);
  assert.equal((await demoRep.get('me')).status, 401);
  assert.equal((await ok(admin.get('demo'))).loaded, false);
  await ok(admin.post('demo')); await ok(admin.del('demo')); // loads again after removal
  assert.deepEqual(await count(), before);
});
