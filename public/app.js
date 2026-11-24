const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
const inr = (n) => n == null ? '—' : '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const today = () => new Date(Date.now() + 330 * 6e4).toISOString().slice(0, 10);
const label = (s) => String(s ?? '').replaceAll('_', ' ');
const utc = (s) => new Date(s.replace(' ', 'T') + 'Z'); // the database stores UTC
const when = (s) => s ? utc(s).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const ago = (s) => { if (!s) return 'never'; const d = Math.floor((Date.now() - utc(s)) / 864e5); return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d + ' days ago'; };
const open = (l) => !['won', 'lost'].includes(l.stage);
const SENT = ['issued', 'accepted', 'rejected'];
async function api(path, opts = {}) {
  const res = await fetch('/api/' + path, { headers: { 'content-type': 'application/json' }, ...opts, body: opts.body && JSON.stringify(opts.body) });
  const data = await res.json().catch(() => ({}));
  // only a session that ended mid-use sends the user back to sign-in; re-booting while already signed out would loop forever
  if (res.status === 401 && me) { me = null; boot(); throw new Error('Signed out'); }
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
// Runs an action from a click and shows any error in the given element instead of failing silently.
const run = (errSel, fn) => async (ev) => { const e = $(errSel); if (e) e.textContent = ''; try { await fn(ev); } catch (x) { if (x.message !== 'Signed out') e ? (e.textContent = x.message) : alertBar(x.message); } };
// Messages slide in from the right and leave on their own; errors stay longer.
function alertBar(msg, bad = true) {
  const box = $('.toasts') ?? document.body.appendChild(Object.assign(document.createElement('div'), { className: 'toasts' }));
  const t = Object.assign(document.createElement('div'), { className: 'toast' + (bad ? ' bad' : ''), textContent: msg });
  t.setAttribute('role', bad ? 'alert' : 'status'); box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 260); }, bad ? 8000 : 5000);
}
const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
// Dashboard figures count up to their value, easing out like the soft spring.
function countUp(el) {
  const n = +el.dataset.n, fmt = el.dataset.inr ? inr : (v) => Math.round(v).toLocaleString('en-IN');
  if (calm || !n) return void (el.textContent = fmt(n));
  const t0 = performance.now();
  const step = (t) => { const k = Math.min(1, (t - t0) / 700); el.textContent = fmt(n * (1 - Math.pow(1 - k, 4))); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
// Rows arrive one after another the first time a list shows; later reloads (typing in search) do not replay it.
const stagger = (box, first) => { box.classList.toggle('fresh', first); $$('tr', box).forEach((tr, i) => tr.style.setProperty('--i', i)); };
// The highlight behind the active tab slides from the tab you left to the one you opened.
let pillAt = null;
function movePill() {
  const pill = $('header nav .pill'), on = $('header nav a.on');
  if (!on) { pill.style.opacity = 0; pillAt = null; return; }
  const set = (p) => { pill.style.transform = `translateX(${p.x}px)`; pill.style.width = p.w + 'px'; };
  if (pillAt) { pill.style.transition = 'none'; set(pillAt); pill.offsetWidth; pill.style.transition = ''; }
  set(pillAt = { x: on.offsetLeft, w: on.offsetWidth });
}
const app = $('#app');
let me = null, meta = null;
const isAdmin = () => me.role === 'admin';

function authForm(setup) {
  app.innerHTML = `<form class="auth card" id="af"><img src="/logo.png" alt="VTech"><h2 style="margin:0">${setup ? 'Create admin account' : 'Sign in'}</h2><p class="muted" style="margin-top:2px">Sales</p>
    ${setup ? '<label for="name">Name</label><input id="name" required>' : ''}<label for="email">Email</label><input id="email" type="email" autocomplete="username" required>
    <label for="password">Password</label><input id="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required>
    <p class="err" id="err" role="alert"></p><button class="primary">${setup ? 'Create account' : 'Sign in'}</button></form>`;
  $('#af').onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const b = { email: $('#email').value, password: $('#password').value, name: setup ? $('#name').value : undefined };
      if (setup) await api('setup', { method: 'POST', body: b });
      await api('login', { method: 'POST', body: b });
      boot();
    } catch (e) { $('#err').textContent = e.message; }
  };
}

function shell(active, inner) {
  const tabs = [['dashboard', 'Dashboard'], ['leads', 'Leads'], ['boqs', 'BOQs'], ['prices', 'Price list'], ...(isAdmin() ? [['users', 'Users']] : [])];
  app.innerHTML = `<header><a class="brand" href="#dashboard"><img src="/logo.png" alt="VTech"><span>Sales</span></a><nav><i class="pill"></i>${tabs.map(([k, l]) => `<a href="#${k}" class="${active === k ? 'on' : ''}">${l}</a>`).join('')}</nav>
    <span class="who"><a href="#account">${esc(me.name)}</a> · <button class="link" id="out">Sign out</button></span></header><main>${inner}</main>`;
  $('#out').onclick = async () => { await api('logout', { method: 'POST' }); me = null; pillAt = null; boot(); };
  movePill();
}

async function dashboard() {
  const d = await api('dashboard');
  const by = Object.fromEntries(d.byStage.map((s) => [s.stage, s]));
  const live = d.byStage.filter(open);
  const card = (title, stat, sub, cls = '', money = false) => `<div class="card"><div class="muted">${title}</div><div class="stat ${cls}" data-n="${stat}" ${money ? 'data-inr="1"' : ''}>${money ? inr(stat) : stat}</div>${sub}</div>`;
  shell('dashboard', `<div class="grid">
    ${card('Follow-ups due', d.due, '<a href="#leads/due">View</a>', d.due ? 'overdue' : '')}
    ${card('No contact in 7+ days', d.stale, '<a href="#leads/stale">View</a>', d.stale ? 'overdue' : '')}
    ${d.pending ? card('BOQs awaiting approval', d.pending, '<a href="#boqs/pending_approval">Review</a>', 'overdue') : ''}
    ${card('New leads this month', d.new_leads, `<span class="muted">${d.byStage.reduce((s, x) => s + x.n, 0)} in total</span>`)}
    ${card('BOQs sent this month', d.boq_n, `<span class="muted">${inr(d.boq_value)}</span> · <a href="#boqs">All BOQs</a>`)}
    ${card('Open pipeline', live.reduce((s, x) => s + x.value, 0), `<span class="muted">${live.reduce((s, x) => s + x.n, 0)} leads</span>`, '', true)}
    ${card('Won', by.won?.value ?? 0, `<span class="muted">${by.won?.n ?? 0} leads</span>`, 'won', true)}</div>
    <div class="grid"><div class="card"><h3>By stage</h3><table>${meta.stages.map((s) => `<tr><td>${label(s)}</td><td class="r">${by[s]?.n ?? 0}</td><td class="r">${inr(by[s]?.value ?? 0)}</td></tr>`).join('')}</table></div>
    <div class="card scroll"><h3>By salesperson</h3><table style="min-width:420px"><tr><th>Name</th><th class="r">Leads</th><th class="r">Open</th><th class="r">Due</th><th class="r">BOQs sent</th><th class="r">Won value</th></tr>
      ${d.byOwner.map((o) => `<tr><td>${esc(o.name)}</td><td class="r">${o.leads}</td><td class="r">${o.open_leads}</td><td class="r ${o.due ? 'overdue' : ''}">${o.due}</td><td class="r">${o.boqs}</td><td class="r">${inr(o.won_value)}</td></tr>`).join('')}</table></div></div>`);
  $$('.stat').forEach(countUp);
}

const leadForm = (l = {}) => `<div class="form">
  <label>Company *<input name="company" value="${esc(l.company)}"></label><label>Contact<input name="contact" value="${esc(l.contact)}"></label>
  <label>Phone<input name="phone" type="tel" value="${esc(l.phone)}"></label><label>Email<input name="email" type="email" value="${esc(l.email)}"></label>
  <label>City<input name="city" value="${esc(l.city)}"></label><label>Source<input name="source" value="${esc(l.source)}" placeholder="Referral, architect, walk-in…"></label>
  <label>Stage<select name="stage">${meta.stages.map((s) => `<option value="${s}" ${s === (l.stage || 'new') ? 'selected' : ''}>${label(s)}</option>`).join('')}</select></label>
  <label>Est. value (₹)<input name="est_value" type="number" min="0" value="${esc(l.est_value)}"></label>
  <label>Next follow-up<input name="next_followup" type="date" value="${esc(l.next_followup)}"></label>
  ${isAdmin() && l.id ? `<label>Salesperson<select name="owner_id">${meta.users.map((u) => `<option value="${u.id}" ${u.id === l.owner_id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>` : ''}
  </div><label class="muted" style="display:block;margin-top:10px;font-size:12px;font-weight:600">Client requirements<textarea name="requirements" placeholder="Rooms, systems, brands asked for, budget, timeline…">${esc(l.requirements)}</textarea></label>
  <label class="muted" style="display:block;margin-top:10px;font-size:12px;font-weight:600">Internal notes<textarea name="notes">${esc(l.notes)}</textarea></label>`;
const formData = (el) => Object.fromEntries($$('[name]', el).map((i) => [i.name, i.value]));

function download(name, rows) {
  // a leading ' stops Excel running a cell that starts with = + - @ as a formula
  const cell = (v) => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replaceAll('"', '""') + '"'; };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv' }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}

async function leads(mode) {
  shell('leads', `<div class="bar"><input id="q" aria-label="Search leads" placeholder="Search company, contact, phone, city" style="flex:1;min-width:220px">
    <select id="stage" aria-label="Stage"><option value="">All stages</option>${meta.stages.map((s) => `<option value="${s}">${label(s)}</option>`).join('')}</select>
    ${isAdmin() ? `<select id="owner" aria-label="Salesperson"><option value="0">Everyone</option>${meta.users.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select>` : ''}
    <label class="muted"><input type="checkbox" id="due" ${mode === 'due' ? 'checked' : ''}> Follow-up due</label>
    <label class="muted"><input type="checkbox" id="stale" ${mode === 'stale' ? 'checked' : ''}> No contact 7+ days</label>
    <button class="link" id="csv">Export</button><button class="primary" id="new">New lead</button></div>
    <div class="card" id="newcard" hidden><h3>New lead</h3><div id="nf">${leadForm()}</div><p class="err" id="nerr" role="alert"></p><button class="primary" id="save">Save lead</button></div>
    <div class="card scroll" id="list">Loading…</div>`);
  let rows = [], first = true;
  const load = async () => {
    const qs = new URLSearchParams({ q: $('#q').value, stage: $('#stage').value, owner: $('#owner')?.value ?? '0', due: $('#due').checked ? '1' : '0', stale: $('#stale').checked ? '1' : '0' });
    rows = await api('leads?' + qs);
    $('#list').innerHTML = !rows.length ? '<p class="muted">No leads match.</p>' : `<table><tr><th>Company</th><th>Contact</th><th>Stage</th>${isAdmin() ? '<th>Salesperson</th>' : ''}<th>Last interaction</th><th>Next follow-up</th><th class="r">BOQs sent</th><th class="r">Last BOQ</th></tr>
      ${rows.map((l) => `<tr><td><a href="#lead/${l.id}">${esc(l.company)}</a><br><span class="muted">${esc(l.city)}</span></td><td>${esc(l.contact)}<br><span class="muted">${esc(l.phone)}</span></td>
        <td><span class="tag">${label(l.stage)}</span></td>${isAdmin() ? `<td>${esc(l.owner_name)}</td>` : ''}
        <td>${l.last_at ? `${label(l.last_kind)} · ${ago(l.last_at)}<div class="muted clip" title="${esc(l.last_note)}">${esc(l.last_note)}</div>` : '<span class="muted">none yet</span>'}</td>
        <td class="${l.next_followup && l.next_followup <= today() && open(l) ? 'overdue' : ''}">${esc(l.next_followup ?? '—')}</td>
        <td class="r">${l.boq_count}</td><td class="r">${l.last_boq_on ? `${inr(l.last_boq_total)}<br><span class="muted">${esc(l.last_boq_on)}</span>` : '—'}</td></tr>`).join('')}</table>`;
    stagger($('#list'), first); first = false;
  };
  const reload = run('#nerr', load);
  let t; $('#q').oninput = () => { clearTimeout(t); t = setTimeout(reload, 250); };
  ['#stage', '#owner', '#due', '#stale'].forEach((s) => $(s) && ($(s).onchange = reload));
  $('#new').onclick = () => ($('#newcard').hidden = !$('#newcard').hidden);
  $('#save').onclick = run('#nerr', async () => { const r = await api('leads', { method: 'POST', body: formData($('#nf')) }); location.hash = 'lead/' + r.id; });
  $('#csv').onclick = () => download(`vtech-leads-${today()}.csv`, [
    ['Company', 'Contact', 'Phone', 'Email', 'City', 'Source', 'Stage', 'Salesperson', 'Est. value', 'Requirements', 'Last interaction', 'Last interaction type', 'Last interaction note', 'Next follow-up', 'BOQs sent', 'Last BOQ ref', 'Last BOQ date', 'Last BOQ total'],
    ...rows.map((l) => [l.company, l.contact, l.phone, l.email, l.city, l.source, label(l.stage), l.owner_name, l.est_value, l.requirements, l.last_at ? when(l.last_at) : '', label(l.last_kind), l.last_note, l.next_followup, l.boq_count, l.last_boq_ref, l.last_boq_on, l.last_boq_total])]);
  reload();
}

const statusTag = (s) => `<span class="tag ${s === 'pending_approval' ? 'over' : ''}">${s === 'pending_approval' ? 'awaiting approval' : label(s)}</span>`;
const decide = (id, status, note) => api('boqs/' + id, { method: 'PATCH', body: { status, decision_note: note } });

async function leadView(id) {
  const [l, products] = await Promise.all([api('leads/' + id), api('products')]);
  const active = products.filter((p) => p.active);
  const byName = new Map(active.map((p) => [`${p.sku} — ${p.name}`, p]));
  const lastQuote = new Map(); // first row per product is the newest
  l.quoted.forEach((q) => lastQuote.has(q.product_id) || lastQuote.set(q.product_id, q));
  const capFor = (p) => Math.min(p.max_discount_pct, me.max_discount_pct);
  shell('leads', `<p><a href="#leads">← Leads</a></p>
    <div class="card"><h2 style="margin-top:0">${esc(l.company)} ${`<span class="tag">${label(l.stage)}</span>`}</h2><div id="ef">${leadForm(l)}</div><p class="err" id="eerr" role="alert"></p><button class="primary" id="upd">Save changes</button></div>
    <div class="grid"><div class="card"><h3>Log interaction</h3><div class="form" id="if">
      <label>Type<select name="kind">${meta.kinds.map((k) => `<option value="${k}">${label(k)}</option>`).join('')}</select></label>
      <label>Next follow-up<input name="next_followup" type="date" value="${esc(l.next_followup)}"></label>
      <label>Move stage to<select name="stage"><option value="">(no change)</option>${meta.stages.map((s) => `<option value="${s}">${label(s)}</option>`).join('')}</select></label></div>
      <textarea name="note" aria-label="What happened" placeholder="What happened?" style="margin-top:10px"></textarea><p class="err" id="ierr" role="alert"></p><button class="primary" id="log">Add</button>
      <h3>History</h3>${l.interactions.map((i) => `<p><span class="tag">${label(i.kind)}</span> <span class="muted">${when(i.at)} · ${esc(i.user_name)}</span><br>${esc(i.note)}</p>`).join('') || '<p class="muted">No interactions yet.</p>'}</div>
    <div class="card"><h3>BOQs</h3><div class="scroll"><table style="min-width:420px"><tr><th>Ref</th><th>Date</th><th class="r">Total</th><th>Status</th><th></th></tr>
      ${l.boqs.map((b) => `<tr><td><a href="#boq/${b.id}">${esc(b.ref)}</a></td><td>${esc(b.issued_on)}</td><td class="r">${inr(b.total)}</td>
        <td>${SENT.includes(b.status) ? `<select data-bs="${b.id}" aria-label="Status of ${esc(b.ref)}">${SENT.map((s) => `<option ${s === b.status ? 'selected' : ''}>${s}</option>`).join('')}</select>` : statusTag(b.status)}</td>
        <td><button class="link" data-rev="${b.id}">Revise</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">None yet</td></tr>'}</table></div>
      <h3 id="nbh">New BOQ</h3><datalist id="plist">${active.map((p) => `<option value="${esc(`${p.sku} — ${p.name}`)}">${esc(p.brand ?? '')} ${inr(p.unit_price)}</option>`).join('')}</datalist>
      <div id="lines"></div>
      <button class="link" id="addline">+ Add item</button>${isAdmin() ? ' · <button class="link" id="addcustom">+ Item not on the price list</button>' : ''}
      <p><b>Total: <span id="btotal">₹0</span></b></p>
      <div id="overbox" hidden><p class="warn">One or more discounts are above your limit. This BOQ will go to an admin for approval before it counts as sent.</p>
        <textarea id="bnote" aria-label="Reason for the discount" placeholder="Why is this discount needed?"></textarea></div>
      <p class="err" id="berr" role="alert"></p><button class="primary" id="mkboq">Issue BOQ</button></div></div>`);

  const recalc = () => {
    let total = 0, over = false;
    $$('.ln').forEach((row) => {
      const custom = row.dataset.custom === '1';
      const p = custom ? null : byName.get($('.p', row).value);
      const price = custom ? +$('.u', row).value || 0 : p?.unit_price ?? 0;
      const disc = +$('.d', row).value || 0;
      const v = price * (+$('.q', row).value || 0) * (1 - disc / 100);
      const lq = p && lastQuote.get(p.id);
      const tooHigh = p && !isAdmin() && disc > capFor(p);
      over ||= tooHigh;
      $('.t', row).textContent = inr(v);
      $('.h', row).innerHTML = custom ? '' : !p ? ($('.p', row).value ? '<span class="over">Pick an item from the price list</span>' : '')
        : `${inr(p.unit_price)} each · <span class="${tooHigh ? 'over' : ''}">${isAdmin() ? `list limit ${p.max_discount_pct}%` : `your limit ${capFor(p)}%`}</span>${lq ? ` · last sent ${inr(lq.unit_price)} at ${lq.discount_pct}% off (${esc(lq.issued_on)})` : ''}`;
      total += v;
    });
    $('#btotal').textContent = inr(total);
    $('#overbox').hidden = !over;
    $('#mkboq').textContent = over ? 'Send for approval' : 'Issue BOQ';
  };
  const addLine = (v = {}, custom = false) => {
    const row = document.createElement('div'); row.className = 'ln'; row.dataset.custom = custom ? '1' : '0';
    row.style.cssText = 'border-bottom:1px solid var(--line);padding:8px 0';
    row.innerHTML = `<div class="bar" style="margin:0">
      ${custom ? `<input class="p" aria-label="Description" placeholder="Description" value="${esc(v.name)}" style="flex:1;min-width:180px"><input class="u" aria-label="Unit price" type="number" min="0" placeholder="Price" value="${esc(v.unit_price)}" style="width:110px">`
        : `<input class="p" list="plist" aria-label="Item" placeholder="Type SKU or name" value="${esc(v.name)}" style="flex:1;min-width:180px">`}
      <input class="q" aria-label="Quantity" type="number" min="0" step="any" value="${esc(v.qty ?? 1)}" style="width:80px" title="Quantity">
      <input class="d" aria-label="Discount percent" type="number" min="0" max="100" step="any" value="${esc(v.discount_pct ?? 0)}" style="width:80px" title="Discount %">
      <b class="t" style="min-width:90px;text-align:right"></b><button class="link x" aria-label="Remove item">✕</button></div><div class="muted h" style="font-size:12px"></div>`;
    $('#lines').append(row); row.oninput = recalc; $('.x', row).onclick = () => { row.classList.add('out'); setTimeout(() => { row.remove(); recalc(); }, calm ? 0 : 110); }; recalc();
  };
  $('#addline').onclick = () => active.length ? addLine() : ($('#berr').textContent = 'The price list is empty — an admin must add products first.');
  if (isAdmin()) $('#addcustom').onclick = () => addLine({}, true);
  $('#mkboq').onclick = run('#berr', async () => {
    const lines = $$('.ln').map((row) => {
      const base = { qty: $('.q', row).value, discount_pct: $('.d', row).value };
      if (row.dataset.custom === '1') return { ...base, description: $('.p', row).value, unit_price: $('.u', row).value };
      const p = byName.get($('.p', row).value);
      if (!p) throw new Error('Pick every item from the price list');
      return { ...base, product_id: p.id };
    });
    const r = await api(`leads/${id}/boqs`, { method: 'POST', body: { lines, note: $('#bnote').value } });
    r.status === 'pending_approval' ? leadView(id).then(() => alertBar(`${r.ref} was sent to an admin for discount approval.`, false)) : (location.hash = 'boq/' + r.id);
  });
  $('#upd').onclick = run('#eerr', async () => { await api('leads/' + id, { method: 'PATCH', body: formData($('#ef')) }); leadView(id); });
  $('#log').onclick = run('#ierr', async () => { await api(`leads/${id}/interactions`, { method: 'POST', body: { ...formData($('#if')), note: $('textarea[name=note]').value } }); leadView(id); });
  $$('[data-bs]').forEach((s) => (s.onchange = run('#berr', () => api('boqs/' + s.dataset.bs, { method: 'PATCH', body: { status: s.value } }))));
  // Revise = start a new BOQ from an old one's items, at today's list prices
  $$('[data-rev]').forEach((b) => (b.onclick = run('#berr', async () => {
    const q = await api('boqs/' + b.dataset.rev);
    $('#lines').innerHTML = '';
    q.lines.forEach((x) => {
      const p = active.find((p) => p.id === x.product_id);
      if (p) addLine({ name: `${p.sku} — ${p.name}`, qty: x.qty, discount_pct: x.discount_pct });
      else if (isAdmin()) addLine({ name: x.description, unit_price: x.unit_price, qty: x.qty, discount_pct: x.discount_pct }, true);
    });
    $('#nbh').textContent = `New BOQ (revising ${q.ref})`; $('#nbh').scrollIntoView({ behavior: 'smooth' });
  })));
}

async function boqs(status) {
  shell('boqs', `<div class="bar"><select id="bst" aria-label="Status"><option value="">All statuses</option>${['pending_approval', ...SENT].map((s) => `<option value="${s}" ${s === status ? 'selected' : ''}>${s === 'pending_approval' ? 'awaiting approval' : s}</option>`).join('')}</select>
    ${isAdmin() ? `<select id="bow" aria-label="Salesperson"><option value="0">Everyone</option>${meta.users.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select>` : ''}
    <label class="muted">From <input type="date" id="bfrom"></label><label class="muted">To <input type="date" id="bto"></label><button class="link" id="bcsv">Export</button></div>
    <p class="err" id="berr" role="alert"></p><div class="card scroll" id="blist">Loading…</div>`);
  let rows = [], first = true;
  const load = run('#berr', async () => {
    rows = await api('boqs?' + new URLSearchParams({ status: $('#bst').value, owner: $('#bow')?.value ?? '0', from: $('#bfrom').value, to: $('#bto').value }));
    const sent = rows.filter((b) => SENT.includes(b.status));
    $('#blist').innerHTML = !rows.length ? '<p class="muted">No BOQs match.</p>' : `<p><b>${sent.length}</b> sent, worth <b>${inr(sent.reduce((s, b) => s + b.total, 0))}</b>${rows.length - sent.length ? ` · <span class="over">${rows.length - sent.length} awaiting approval</span>` : ''}</p>
      <table><tr><th>Ref</th><th>Client</th><th>Salesperson</th><th>Date</th><th class="r">Total</th><th>Status</th></tr>
      ${rows.map((b) => `<tr><td><a href="#boq/${b.id}">${esc(b.ref)}</a></td><td><a href="#lead/${b.lead_id}">${esc(b.company)}</a></td><td>${esc(b.owner_name)}</td><td>${esc(b.issued_on)}</td><td class="r">${inr(b.total)}</td>
        <td>${statusTag(b.status)}${b.status === 'pending_approval' ? `<div class="muted">${b.over_lines} item(s) over limit${b.note ? ' · ' + esc(b.note) : ''}</div>${isAdmin() ? `<a href="#boq/${b.id}">Review</a>` : ''}` : ''}</td></tr>`).join('')}</table>`;
    stagger($('#blist'), first); first = false;
  });
  ['#bst', '#bow', '#bfrom', '#bto'].forEach((s) => $(s) && ($(s).onchange = load));
  $('#bcsv').onclick = () => download(`vtech-boqs-${today()}.csv`, [['Ref', 'Client', 'Salesperson', 'Prepared by', 'Date', 'Total', 'Status', 'Note'],
    ...rows.map((b) => [b.ref, b.company, b.owner_name, b.user_name, b.issued_on, b.total, label(b.status), b.note])]);
  load();
}

async function boqView(id) {
  const q = await api('boqs/' + id);
  const pending = q.status === 'pending_approval';
  const overLine = (x) => x.cap_pct != null && x.discount_pct > x.cap_pct;
  shell('boqs', `<p class="noprint"><a href="#lead/${q.lead_id}">← ${esc(q.lead.company)}</a> · <button class="link" id="print">Print / save as PDF</button></p>
    ${pending ? `<div class="warn noprint"><b>Awaiting admin approval.</b> Discounts above the limit are marked below. Do not send this to the client yet.${q.note ? `<br>Reason given: ${esc(q.note)}` : ''}
      ${isAdmin() ? `<div class="bar" style="margin:8px 0 0"><input id="dnote" aria-label="Note to the salesperson" placeholder="Note to the salesperson (optional)" style="flex:1;min-width:200px"><button class="primary" id="ok">Approve and issue</button><button class="link" id="no">Reject</button></div><p class="err" id="derr" role="alert"></p>` : ''}</div>` : ''}
    ${!pending && q.decided_at ? `<p class="muted noprint">${q.status === 'rejected' ? 'Rejected' : 'Discount approved'} on ${when(q.decided_at)}${q.decision_note ? ' — ' + esc(q.decision_note) : ''}</p>` : ''}
    <div class="doc"><div class="top"><div><img src="/logo.png" alt="VTech"><h1>V-TECH Technologies Pvt. Ltd.</h1><div class="muted">Bill of Quantities</div></div>
      <div><b>${esc(q.ref)}</b><br>Date: ${esc(q.issued_on)}<br>Prepared by: ${esc(q.user_name)}</div></div>
      <p><b>${esc(q.lead.company)}</b><br>${[q.lead.contact, q.lead.phone, q.lead.email, q.lead.city].filter(Boolean).map(esc).join(' · ')}</p>
      <div class="scroll"><table><tr><th>#</th><th>Item</th><th class="r">Qty</th><th class="r">Unit price</th><th class="r">Discount</th><th class="r">Amount</th></tr>
      ${q.lines.map((x, i) => `<tr><td>${i + 1}</td><td>${esc(x.description)}</td><td class="r">${x.qty}</td><td class="r">${inr(x.unit_price)}</td>
        <td class="r ${overLine(x) ? 'over' : ''}">${x.discount_pct}%${overLine(x) ? `<span class="noprint"> (limit ${x.cap_pct}%)</span>` : ''}</td><td class="r">${inr(x.line_total)}</td></tr>`).join('')}
      <tr><td colspan="5" class="r"><b>Total</b></td><td class="r"><b>${inr(q.total)}</b></td></tr></table></div></div>`);
  $('#print').onclick = () => window.print();
  if (pending && isAdmin()) {
    $('#ok').onclick = run('#derr', async () => { await decide(id, 'issued', $('#dnote').value); boqView(id); });
    $('#no').onclick = run('#derr', async () => { await decide(id, 'rejected', $('#dnote').value); boqView(id); });
  }
}

// Minimal CSV reader: handles quoted cells, doubled quotes and line breaks inside quotes.
function parseCsv(text) {
  const rows = [[]]; let cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c; }
    else if (c === '"') quoted = true;
    else if (c === ',') { rows.at(-1).push(cell); cell = ''; }
    else if (c === '\n') { rows.at(-1).push(cell); cell = ''; rows.push([]); }
    else if (c !== '\r') cell += c;
  }
  rows.at(-1).push(cell);
  return rows.filter((r) => r.some((x) => x.trim()));
}

async function prices() {
  const rows = await api('products');
  const admin = isAdmin();
  shell('prices', `${admin ? `<div class="grid"><div class="card"><h3>Add product</h3><div class="form" id="pf"><label>SKU<input name="sku"></label><label>Name<input name="name"></label>
      <label>Brand<input name="brand"></label><label>Unit price (₹)<input name="unit_price" type="number" min="0"></label><label>Max discount %<input name="max_discount_pct" type="number" min="0" max="100" value="0"></label></div>
      <p class="err" id="perr" role="alert"></p><button class="primary" id="padd">Add</button></div>
    <div class="card"><h3>Import from a spreadsheet</h3><p class="muted">Save the sheet as CSV with a header row: <code>sku, name, brand, unit_price, max_discount_pct</code>. Existing SKUs are updated, new ones are added, and every price change is logged.</p>
      <input type="file" id="pfile" accept=".csv,text/csv" aria-label="CSV file"><p class="err" id="imerr" role="alert"></p><p id="immsg" class="muted"></p></div></div>` : ''}
    <div class="bar"><input id="pq" aria-label="Search price list" placeholder="Search SKU, name or brand" style="flex:1;min-width:220px"><span class="muted">${rows.length} products</span></div>
    <p class="err" id="plerr" role="alert"></p>
    <div class="card scroll"><table id="ptable"><tr><th>SKU</th><th>Name</th><th>Brand</th><th class="r">Price</th><th class="r">Max discount</th><th>Updated</th><th></th></tr>
    ${rows.map((p) => `<tr data-row="${esc(`${p.sku} ${p.name} ${p.brand ?? ''}`.toLowerCase())}" style="${p.active ? '' : 'opacity:.5'}"><td>${esc(p.sku)}</td><td>${esc(p.name)}</td><td>${esc(p.brand)}</td>
      <td class="r">${admin ? `<input data-pp="${p.id}" aria-label="Price of ${esc(p.sku)}" type="number" min="0" value="${esc(p.unit_price)}" style="width:110px">` : inr(p.unit_price)}</td>
      <td class="r">${admin ? `<input data-pd="${p.id}" aria-label="Max discount of ${esc(p.sku)}" type="number" min="0" max="100" value="${esc(p.max_discount_pct)}" style="width:70px">` : p.max_discount_pct + '%'}</td>
      <td class="muted">${when(p.updated_at)}</td>
      <td><button class="link" data-ph="${p.id}">History</button>${admin ? ` · <button class="link" data-pa="${p.id}" data-on="${p.active}">${p.active ? 'Retire' : 'Restore'}</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No products yet.</td></tr>'}</table></div>`);
  $('#pq').oninput = () => { const q = $('#pq').value.toLowerCase(); $$('#ptable tr[data-row]').forEach((tr) => (tr.hidden = !tr.dataset.row.includes(q))); $$('#ptable tr.hist').forEach((tr) => tr.remove()); };
  $$('[data-ph]').forEach((b) => (b.onclick = run('#plerr', async () => {
    const tr = b.closest('tr');
    if (tr.nextElementSibling?.classList.contains('hist')) return tr.nextElementSibling.remove();
    const h = await api(`products/${b.dataset.ph}/history`);
    tr.insertAdjacentHTML('afterend', `<tr class="hist"><td colspan="7" style="background:var(--bg)">${h.length ? h.map((x) => `<div>${when(x.at)} · ${esc(x.user_name ?? '—')} · price ${x.old_price == null ? 'set to' : inr(x.old_price) + ' →'} <b>${inr(x.new_price)}</b> · max discount ${x.old_cap == null ? '' : x.old_cap + '% → '}<b>${x.new_cap}%</b></div>`).join('') : '<span class="muted">No changes recorded since history tracking began.</span>'}</td></tr>`);
  })));
  if (!admin) return;
  $('#padd').onclick = run('#perr', async () => { await api('products', { method: 'POST', body: formData($('#pf')) }); prices(); });
  const patch = (id, body) => run('#plerr', async () => { await api('products/' + id, { method: 'PATCH', body }); });
  $$('[data-pp]').forEach((i) => (i.onchange = (e) => patch(i.dataset.pp, { unit_price: i.value })(e)));
  $$('[data-pd]').forEach((i) => (i.onchange = (e) => patch(i.dataset.pd, { max_discount_pct: i.value })(e)));
  $$('[data-pa]').forEach((b) => (b.onclick = run('#plerr', async () => { await api('products/' + b.dataset.pa, { method: 'PATCH', body: { active: b.dataset.on !== '1' } }); prices(); })));
  $('#pfile').onchange = run('#imerr', async () => {
    const [head, ...data] = parseCsv(await $('#pfile').files[0].text());
    const cols = head.map((h) => h.trim().toLowerCase().replace(/^﻿/, '').replaceAll(' ', '_'));
    if (!['sku', 'name', 'unit_price'].every((c) => cols.includes(c))) throw new Error('The first row must have the columns sku, name and unit_price');
    const keep = ['sku', 'name', 'brand', 'unit_price', 'max_discount_pct'];
    const body = { rows: data.map((r) => Object.fromEntries(cols.map((c, i) => [c, (r[i] ?? '').trim()]).filter(([c, v]) => keep.includes(c) && v !== ''))) };
    const res = await api('products/import', { method: 'POST', body });
    await prices(); $('#immsg').textContent = `Imported: ${res.created} added, ${res.updated} updated.`;
  });
}

async function users() {
  const rows = await api('users');
  shell('users', `<div class="grid"><div class="card scroll" style="grid-column:1/-1"><h3>Team</h3><table><tr><th>Name</th><th>Email</th><th>Role</th><th>Discount limit %</th><th></th></tr>
    ${rows.map((u) => `<tr style="${u.active ? '' : 'opacity:.5'}"><td>${esc(u.name)}</td><td>${esc(u.email)}</td>
      <td>${u.id === me.id ? u.role : `<select data-role="${u.id}" aria-label="Role of ${esc(u.name)}"><option value="member" ${u.role === 'member' ? 'selected' : ''}>salesperson</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>admin</option></select>`}</td>
      <td>${u.role === 'admin' ? '<span class="muted">no limit</span>' : `<input data-cap="${u.id}" aria-label="Discount limit of ${esc(u.name)}" type="number" min="0" max="100" value="${esc(u.max_discount_pct)}" style="width:80px">`}</td>
      <td>${u.id === me.id ? '' : `<button class="link" data-pw="${u.id}">Reset password</button> · <button class="link" data-id="${u.id}" data-active="${u.active}">${u.active ? 'Disable' : 'Enable'}</button>`}</td></tr>`).join('')}</table>
    <p class="err" id="terr" role="alert"></p>
    <p class="muted">A salesperson can give a discount up to the lower of their own limit and the product's max discount. Anything higher goes to an admin for approval.</p>
    <p class="muted">Follow-up reminders go out daily at 08:30 IST. Each salesperson's email must be verified once in Cloudflare Email Routing.</p><button class="link" id="rem">Send reminders now</button> <span id="rmsg" class="muted"></span></div>
    <div class="card"><h3>Add salesperson</h3><div class="form" id="uf"><label>Name<input name="name"></label><label>Email<input name="email" type="email"></label>
      <label>Temporary password<input name="password" placeholder="10+ characters"></label><label>Role<select name="role"><option value="member">salesperson</option><option value="admin">admin</option></select></label>
      <label>Discount limit %<input name="max_discount_pct" type="number" min="0" max="100" value="100"></label></div>
      <p class="err" id="uerr" role="alert"></p><button class="primary" id="uadd">Add</button></div></div>`);
  const patch = (id, body) => run('#terr', async () => { await api('users/' + id, { method: 'PATCH', body }); meta = await api('meta'); users(); });
  $('#uadd').onclick = run('#uerr', async () => { await api('users', { method: 'POST', body: formData($('#uf')) }); meta = await api('meta'); users(); });
  $('#rem').onclick = run('#terr', async () => { const r = await api('send-reminders', { method: 'POST' }); $('#rmsg').textContent = `Sent to ${r.sent} of ${r.users}${r.failed.length ? '; failed: ' + r.failed.join(', ') : ''}`; });
  $$('button[data-id]').forEach((b) => (b.onclick = (e) => patch(b.dataset.id, { active: b.dataset.active !== '1' })(e)));
  $$('[data-role]').forEach((s) => (s.onchange = (e) => patch(s.dataset.role, { role: s.value })(e)));
  $$('[data-cap]').forEach((i) => (i.onchange = (e) => patch(i.dataset.cap, { max_discount_pct: i.value })(e)));
  $$('[data-pw]').forEach((b) => (b.onclick = () => {
    b.outerHTML = `<input id="npw" aria-label="New password" placeholder="New password, 10+ characters" style="width:220px"> <button class="link" id="npws">Save</button>`;
    $('#npws').onclick = run('#terr', async () => { await api('users/' + b.dataset.pw, { method: 'PATCH', body: { password: $('#npw').value } }); users(); });
  }));
}

async function account() {
  shell('', `<form class="card" id="pwf" style="max-width:420px"><h3>Change password</h3><p class="muted">${esc(me.email)}${isAdmin() ? '' : ` · your discount limit is ${me.max_discount_pct}%`}</p>
    <div class="form" style="grid-template-columns:1fr"><label>Current password<input id="cur" type="password" autocomplete="current-password" required></label>
    <label>New password (10+ characters)<input id="npw" type="password" autocomplete="new-password" minlength="10" required></label></div>
    <p class="err" id="aerr" role="alert"></p><button class="primary">Change password</button><p class="muted">You will be signed out everywhere and asked to sign in again.</p></form>`);
  $('#pwf').onsubmit = (ev) => { ev.preventDefault(); run('#aerr', async () => { await api('me/password', { method: 'POST', body: { current: $('#cur').value, password: $('#npw').value } }); me = null; boot(); })(); };
}

function route() {
  if (!me) return;
  const [v, arg] = (location.hash.slice(1) || 'dashboard').split('/');
  const go = { dashboard, leads: () => leads(arg), lead: () => leadView(arg), boqs: () => boqs(arg), boq: () => boqView(arg), prices, account, users: isAdmin() ? users : dashboard }[v] || dashboard;
  go().catch((e) => { if (e.message !== 'Signed out') alertBar(e.message); });
}
window.onhashchange = route;
async function boot() {
  try { me = await api('me'); meta = await api('meta'); route(); }
  catch { me = null; const { needsSetup } = await api('needs-setup'); authForm(needsSetup); }
}
boot();
