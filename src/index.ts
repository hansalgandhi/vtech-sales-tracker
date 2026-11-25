// VTech Sales Tracker — lead tracking per salesperson, interactions, follow-up reminders, BOQs issued,
// and an admin-controlled price list with discount caps and approvals. Cloudflare Worker + D1.
import { AUTH_SCHEMA, currentUser, login, logout, setup, createUser, updateUser, listUsers, changeOwnPassword, type User } from './auth';
import { sendMail, esc } from './mail';
import { DEMO_SCHEMA, DEMO_DOMAIN, demoStatus, loadDemo, clearDemo } from './demo';

export interface Env { DB: D1Database; ASSETS: Fetcher; MAILER: SendEmail; ADMIN_EMAIL: string; MAIL_FROM: string }

const STAGES = ['new', 'contacted', 'site_visit', 'boq_sent', 'negotiation', 'won', 'lost'] as const;
const KINDS = ['call', 'meeting', 'site_visit', 'email', 'whatsapp', 'note'] as const;
// 'draft' is kept only so BOQs saved under the first version still display.
const BOQ_STATUS = ['pending_approval', 'issued', 'accepted', 'rejected', 'draft'] as const;
const SENT = `('issued','accepted','rejected')`; // statuses that mean the BOQ reached the client

const SCHEMA = `${AUTH_SCHEMA}
CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY, sku TEXT UNIQUE NOT NULL, name TEXT NOT NULL, brand TEXT,
  unit_price REAL NOT NULL CHECK (unit_price >= 0), max_discount_pct REAL NOT NULL DEFAULT 0 CHECK (max_discount_pct BETWEEN 0 AND 100),
  active INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id), company TEXT NOT NULL,
  contact TEXT, phone TEXT, email TEXT, city TEXT, source TEXT, stage TEXT NOT NULL DEFAULT 'new', est_value REAL,
  next_followup TEXT, notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS leads_owner ON leads(owner_id, next_followup);
CREATE TABLE IF NOT EXISTS interactions (id INTEGER PRIMARY KEY, lead_id INTEGER NOT NULL REFERENCES leads(id), user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL, note TEXT, at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS interactions_lead ON interactions(lead_id, at);
CREATE TABLE IF NOT EXISTS boqs (id INTEGER PRIMARY KEY, lead_id INTEGER NOT NULL REFERENCES leads(id), user_id INTEGER NOT NULL REFERENCES users(id),
  ref TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'issued', issued_on TEXT NOT NULL DEFAULT (date('now', '+330 minutes')),
  total REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS boqs_lead ON boqs(lead_id);
CREATE TABLE IF NOT EXISTS boq_lines (id INTEGER PRIMARY KEY, boq_id INTEGER NOT NULL REFERENCES boqs(id), product_id INTEGER REFERENCES products(id),
  description TEXT NOT NULL, qty REAL NOT NULL, unit_price REAL NOT NULL, discount_pct REAL NOT NULL DEFAULT 0, line_total REAL NOT NULL);
CREATE INDEX IF NOT EXISTS boq_lines_boq ON boq_lines(boq_id);
CREATE TABLE IF NOT EXISTS price_history (id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id), user_id INTEGER REFERENCES users(id),
  old_price REAL, new_price REAL NOT NULL, old_cap REAL, new_cap REAL NOT NULL, at TEXT NOT NULL DEFAULT (datetime('now')));
${DEMO_SCHEMA}`;

// Columns added after the first release. The live database already has the tables, so they are added one by one.
const COLUMNS: Record<string, Record<string, string>> = {
  users: { max_discount_pct: 'REAL NOT NULL DEFAULT 100' }, // a salesperson's own ceiling; 100 = only the product cap applies
  leads: { requirements: 'TEXT' },
  boqs: { note: 'TEXT', decided_by: 'INTEGER', decided_at: 'TEXT', decision_note: 'TEXT' },
  boq_lines: { cap_pct: 'REAL' }, // the discount cap in force when the line was quoted
};

let ready = false;
async function ensureSchema(db: D1Database) {
  if (ready) return;
  await db.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => db.prepare(s)));
  for (const [table, cols] of Object.entries(COLUMNS)) {
    const have = new Set((await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()).results.map((c) => c.name));
    for (const [col, ddl] of Object.entries(cols)) if (!have.has(col)) await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`).run();
  }
  ready = true;
}

const json = (d: unknown, status = 200) => Response.json(d, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
const str = (v: unknown, max = 500) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));
const num = (v: unknown) => (v === undefined || v === null || v === '' || !isFinite(Number(v)) ? null : Number(v));
const date = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const todayIST = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const round2 = (n: number) => Math.round(n * 100) / 100;
const BUMP_STAGE = `UPDATE leads SET stage = CASE WHEN stage IN ('new','contacted','site_visit') THEN 'boq_sent' ELSE stage END, updated_at = datetime('now') WHERE id = ?`;

async function leadFor(db: D1Database, user: User, id: number) {
  const lead = await db.prepare('SELECT * FROM leads WHERE id = ?').bind(id).first<Record<string, any>>();
  if (!lead || (user.role !== 'admin' && lead.owner_id !== user.id)) return null;
  return lead;
}

async function mailAdmins(env: Env, subject: string, html: string) {
  const { results } = await env.DB.prepare(`SELECT email FROM users WHERE role = 'admin' AND active = 1`).all<{ email: string }>();
  for (const a of results) await sendMail(env.MAILER, env.MAIL_FROM, 'VTech Sales Tracker', a.email, subject, html).catch((e) => console.error('mail failed', a.email, e));
}

async function api(req: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const db = env.DB;
  const p = url.pathname;
  const body = async () => (await req.json().catch(() => ({}))) as Record<string, any>;

  // Browsers send Origin on cross-site writes; refuse those even if a cookie came along.
  const origin = req.headers.get('origin');
  if (req.method !== 'GET' && origin && origin !== url.origin) return json({ error: 'forbidden' }, 403);

  if (p === '/api/login' && req.method === 'POST') return login(db, await body(), req.headers.get('cf-connecting-ip') ?? 'unknown');
  if (p === '/api/setup' && req.method === 'POST') return setup(db, env.ADMIN_EMAIL, await body());
  if (p === '/api/needs-setup') return json({ needsSetup: (await db.prepare('SELECT COUNT(*) n FROM users').first<{ n: number }>())!.n === 0 });

  const user = await currentUser(db, req);
  if (!user) return json({ error: 'unauthorized' }, 401);
  const admin = user.role === 'admin';
  if (p === '/api/logout' && req.method === 'POST') return logout(db, req);
  if (p === '/api/me') return json(user);
  if (p === '/api/me/password' && req.method === 'POST') return changeOwnPassword(db, user, await body());
  if (p === '/api/meta') return json({ stages: STAGES, kinds: KINDS, boqStatus: BOQ_STATUS,
    users: (await db.prepare('SELECT id, name FROM users WHERE active = 1 ORDER BY name').all()).results });

  // ---- dashboard (admins see the whole team, salespeople see their own numbers)
  if (p === '/api/dashboard') {
    const me = admin ? 0 : user.id;
    const today = todayIST();
    const month = today.slice(0, 8) + '01';
    const open = `l.stage NOT IN ('won','lost')`;
    const [byStage, counts, byOwner] = await db.batch([
      db.prepare(`SELECT stage, COUNT(*) n, COALESCE(SUM(est_value),0) value FROM leads l WHERE (?1 = 0 OR l.owner_id = ?1) GROUP BY stage`).bind(me),
      db.prepare(`SELECT
          (SELECT COUNT(*) FROM leads l WHERE (?1 = 0 OR l.owner_id = ?1) AND l.next_followup <= ?2 AND ${open}) due,
          (SELECT COUNT(*) FROM leads l WHERE (?1 = 0 OR l.owner_id = ?1) AND date(l.created_at, '+330 minutes') >= ?3) new_leads,
          (SELECT COUNT(*) FROM leads l WHERE (?1 = 0 OR l.owner_id = ?1) AND ${open}
             AND COALESCE((SELECT MAX(at) FROM interactions i WHERE i.lead_id = l.id), l.created_at) < datetime('now', '-7 days')) stale,
          (SELECT COUNT(*) FROM boqs b JOIN leads l ON l.id = b.lead_id WHERE (?1 = 0 OR l.owner_id = ?1) AND b.status = 'pending_approval') pending,
          (SELECT COUNT(*) FROM boqs b JOIN leads l ON l.id = b.lead_id WHERE (?1 = 0 OR l.owner_id = ?1) AND b.status IN ${SENT} AND b.issued_on >= ?3) boq_n,
          (SELECT COALESCE(SUM(b.total),0) FROM boqs b JOIN leads l ON l.id = b.lead_id WHERE (?1 = 0 OR l.owner_id = ?1) AND b.status IN ${SENT} AND b.issued_on >= ?3) boq_value`)
        .bind(me, today, month),
      db.prepare(`SELECT u.name, COUNT(l.id) leads, COALESCE(SUM(CASE WHEN l.stage NOT IN ('won','lost') THEN 1 END),0) open_leads,
          COALESCE(SUM(CASE WHEN l.next_followup <= ?2 AND l.stage NOT IN ('won','lost') THEN 1 END),0) due,
          (SELECT COUNT(*) FROM boqs b JOIN leads x ON x.id = b.lead_id WHERE x.owner_id = u.id AND b.status IN ${SENT}) boqs,
          COALESCE(SUM(CASE WHEN l.stage = 'won' THEN l.est_value END),0) won_value
        FROM users u LEFT JOIN leads l ON l.owner_id = u.id WHERE u.active = 1 AND (?1 = 0 OR u.id = ?1) GROUP BY u.id ORDER BY leads DESC`).bind(me, today),
    ]);
    return json({ byStage: byStage.results, ...(counts.results[0] as object), byOwner: byOwner.results });
  }

  // ---- leads
  if (p === '/api/leads' && req.method === 'GET') {
    const sp = url.searchParams;
    const owner = admin ? Number(sp.get('owner') || 0) : user.id;
    const lastI = (col: string) => `(SELECT i.${col} FROM interactions i WHERE i.lead_id = l.id ORDER BY i.at DESC, i.id DESC LIMIT 1)`;
    const lastB = (col: string) => `(SELECT b.${col} FROM boqs b WHERE b.lead_id = l.id AND b.status IN ${SENT} ORDER BY b.id DESC LIMIT 1)`;
    const { results } = await db.prepare(`SELECT l.*, u.name owner_name,
        ${lastI('at')} last_at, ${lastI('kind')} last_kind, ${lastI('note')} last_note,
        (SELECT COUNT(*) FROM boqs b WHERE b.lead_id = l.id AND b.status IN ${SENT}) boq_count,
        ${lastB('total')} last_boq_total, ${lastB('issued_on')} last_boq_on, ${lastB('ref')} last_boq_ref
        FROM leads l JOIN users u ON u.id = l.owner_id
        WHERE (l.company LIKE ?1 OR l.contact LIKE ?1 OR l.phone LIKE ?1 OR l.city LIKE ?1) AND (?2 = '' OR l.stage = ?2)
          AND (?3 = 0 OR l.owner_id = ?3) AND (?4 = 0 OR (l.next_followup <= ?5 AND l.stage NOT IN ('won','lost')))
          AND (?6 = 0 OR (l.stage NOT IN ('won','lost')
            AND COALESCE((SELECT MAX(at) FROM interactions i WHERE i.lead_id = l.id), l.created_at) < datetime('now', '-7 days')))
        ORDER BY CASE WHEN l.next_followup IS NULL THEN 1 ELSE 0 END, l.next_followup, l.updated_at DESC LIMIT 500`)
      .bind(`%${sp.get('q') ?? ''}%`, sp.get('stage') ?? '', owner, sp.get('due') === '1' ? 1 : 0, todayIST(), sp.get('stale') === '1' ? 1 : 0).all();
    return json(results);
  }
  const leadFields = (b: Record<string, any>) => ({
    company: str(b.company, 200), contact: str(b.contact, 120), phone: str(b.phone, 40), email: str(b.email, 200), city: str(b.city, 80),
    source: str(b.source, 80), stage: STAGES.includes(b.stage) ? b.stage : null, est_value: num(b.est_value),
    next_followup: date(b.next_followup), notes: str(b.notes, 4000), requirements: str(b.requirements, 4000),
  });
  if (p === '/api/leads' && req.method === 'POST') {
    const f = leadFields(await body());
    if (!f.company) return json({ error: 'Company is required' }, 400);
    const r = await db.prepare(`INSERT INTO leads (owner_id, company, contact, phone, email, city, source, stage, est_value, next_followup, notes, requirements)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`).bind(user.id, f.company, f.contact, f.phone, f.email, f.city, f.source, f.stage ?? 'new',
      f.est_value, f.next_followup, f.notes, f.requirements).first<{ id: number }>();
    return json(r);
  }
  const leadM = p.match(/^\/api\/leads\/(\d+)(\/(interactions|boqs))?$/);
  if (leadM) {
    const lead = await leadFor(db, user, Number(leadM[1]));
    if (!lead) return json({ error: 'not found' }, 404);
    const sub = leadM[3];
    if (!sub && req.method === 'GET') {
      const [ints, boqs, quoted] = await db.batch([
        db.prepare('SELECT i.*, u.name user_name FROM interactions i JOIN users u ON u.id = i.user_id WHERE lead_id = ? ORDER BY i.at DESC, i.id DESC').bind(lead.id),
        db.prepare('SELECT b.*, u.name user_name FROM boqs b JOIN users u ON u.id = b.user_id WHERE lead_id = ? ORDER BY b.id DESC').bind(lead.id),
        // newest first, so the first row per product is the price last sent to this client
        db.prepare(`SELECT bl.product_id, bl.unit_price, bl.discount_pct, b.issued_on, b.ref FROM boq_lines bl JOIN boqs b ON b.id = bl.boq_id
          WHERE b.lead_id = ? AND bl.product_id IS NOT NULL AND b.status IN ${SENT} ORDER BY b.id DESC`).bind(lead.id),
      ]);
      return json({ ...lead, interactions: ints.results, boqs: boqs.results, quoted: quoted.results });
    }
    if (!sub && req.method === 'PATCH') {
      const b = await body();
      const f = leadFields({ ...lead, ...b });
      if (!f.company) return json({ error: 'Company is required' }, 400);
      let owner = lead.owner_id;
      if (admin && num(b.owner_id) && num(b.owner_id) !== owner) {
        if (!(await db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').bind(num(b.owner_id)).first())) return json({ error: 'Unknown salesperson' }, 400);
        owner = num(b.owner_id);
      }
      await db.prepare(`UPDATE leads SET company=?, contact=?, phone=?, email=?, city=?, source=?, stage=?, est_value=?, next_followup=?,
        notes=?, requirements=?, owner_id=?, updated_at=datetime('now') WHERE id=?`).bind(f.company, f.contact, f.phone, f.email, f.city, f.source,
        f.stage ?? lead.stage, f.est_value, f.next_followup, f.notes, f.requirements, owner, lead.id).run();
      return json({ ok: true });
    }
    if (sub === 'interactions' && req.method === 'POST') {
      const b = await body();
      if (!KINDS.includes(b.kind)) return json({ error: 'Invalid interaction type' }, 400);
      if (!str(b.note)) return json({ error: 'Write what happened' }, 400);
      await db.batch([
        db.prepare('INSERT INTO interactions (lead_id, user_id, kind, note) VALUES (?,?,?,?)').bind(lead.id, user.id, b.kind, str(b.note, 4000)),
        db.prepare(`UPDATE leads SET next_followup = ?, stage = COALESCE(?, stage), updated_at = datetime('now') WHERE id = ?`)
          .bind(date(b.next_followup), STAGES.includes(b.stage) ? b.stage : null, lead.id),
      ]);
      return json({ ok: true });
    }
    if (sub === 'boqs' && req.method === 'POST') {
      const b = await body();
      const lines = Array.isArray(b.lines) ? b.lines.slice(0, 300) : [];
      if (!lines.length) return json({ error: 'Add at least one line' }, 400);
      const products = new Map((await db.prepare('SELECT * FROM products WHERE active = 1').all<Record<string, any>>()).results.map((x) => [x.id, x]));
      const priced = [];
      const over: string[] = [];
      for (const l of lines) {
        const qty = num(l.qty);
        if (!qty || qty <= 0) return json({ error: 'Each line needs a quantity' }, 400);
        const disc = num(l.discount_pct) ?? 0;
        if (disc < 0 || disc > 100) return json({ error: 'Discount must be between 0 and 100%' }, 400);
        let unit = num(l.unit_price), desc = str(l.description, 300), pid: number | null = null, cap: number | null = null;
        if (num(l.product_id)) {
          const prod = products.get(num(l.product_id)!);
          if (!prod) return json({ error: 'Unknown product on a line' }, 400);
          // price always comes from the central list; only the discount is the salesperson's to choose
          pid = prod.id; unit = prod.unit_price; desc = `${prod.sku} — ${prod.name}`;
          cap = Math.min(prod.max_discount_pct, user.max_discount_pct);
          if (!admin && disc > cap) over.push(`${prod.name}: ${disc}% (limit ${cap}%)`);
        } else if (!admin) return json({ error: 'Only admins can add lines outside the price list' }, 400);
        if (unit === null || unit < 0 || !desc) return json({ error: 'Each line needs a description and price' }, 400);
        priced.push({ pid, desc, qty, unit, disc, cap, total: round2(qty * unit * (1 - disc / 100)) });
      }
      const total = round2(priced.reduce((s, l) => s + l.total, 0));
      const status = over.length ? 'pending_approval' : 'issued';
      const count = await db.prepare('SELECT COALESCE(MAX(id),0) n FROM boqs').first<{ n: number }>();
      const ref = str(b.ref, 60) ?? `VT-BOQ-${todayIST().replace(/-/g, '')}-${count!.n + 1}`;
      const boq = await db.prepare('INSERT INTO boqs (lead_id, user_id, ref, status, total, note) VALUES (?,?,?,?,?,?) RETURNING id')
        .bind(lead.id, user.id, ref, status, total, str(b.note, 1000)).first<{ id: number }>();
      await db.batch([
        ...priced.map((l) => db.prepare('INSERT INTO boq_lines (boq_id, product_id, description, qty, unit_price, discount_pct, line_total, cap_pct) VALUES (?,?,?,?,?,?,?,?)')
          .bind(boq!.id, l.pid, l.desc, l.qty, l.unit, l.disc, l.total, l.cap)),
        ...(status === 'issued' ? [db.prepare(BUMP_STAGE).bind(lead.id)] : []),
      ]);
      if (over.length) ctx.waitUntil(mailAdmins(env, `Discount approval needed: ${ref}`,
        `<p>${esc(user.name)} has asked for discounts above the limit on <b>${esc(lead.company)}</b> (${esc(ref)}, total ₹${total.toLocaleString('en-IN')}).</p>
         <ul>${over.map((o) => `<li>${esc(o)}</li>`).join('')}</ul>${b.note ? `<p>Reason: ${esc(str(b.note, 1000))}</p>` : ''}
         <p><a href="https://sales.vtech.services/#boqs">Approve or reject</a></p>`));
      return json({ id: boq!.id, ref, total, status });
    }
  }

  // ---- BOQ register
  if (p === '/api/boqs' && req.method === 'GET') {
    const sp = url.searchParams;
    const { results } = await db.prepare(`SELECT b.*, l.company, o.name owner_name, u.name user_name,
        (SELECT COUNT(*) FROM boq_lines bl WHERE bl.boq_id = b.id AND bl.cap_pct IS NOT NULL AND bl.discount_pct > bl.cap_pct) over_lines
        FROM boqs b JOIN leads l ON l.id = b.lead_id JOIN users o ON o.id = l.owner_id JOIN users u ON u.id = b.user_id
        WHERE (?1 = 0 OR l.owner_id = ?1) AND (?2 = '' OR b.status = ?2) AND (?3 = '' OR b.issued_on >= ?3) AND (?4 = '' OR b.issued_on <= ?4)
        ORDER BY b.id DESC LIMIT 500`)
      .bind(admin ? Number(sp.get('owner') || 0) : user.id, sp.get('status') ?? '', date(sp.get('from')) ?? '', date(sp.get('to')) ?? '').all();
    return json(results);
  }
  const boqM = p.match(/^\/api\/boqs\/(\d+)$/);
  if (boqM) {
    const boq = await db.prepare('SELECT b.*, u.name user_name FROM boqs b JOIN users u ON u.id = b.user_id WHERE b.id = ?').bind(Number(boqM[1])).first<Record<string, any>>();
    const lead = boq && (await leadFor(db, user, boq.lead_id));
    if (!boq || !lead) return json({ error: 'not found' }, 404);
    if (req.method === 'GET') return json({ ...boq, lead: { company: lead.company, contact: lead.contact, phone: lead.phone, email: lead.email, city: lead.city },
      lines: (await db.prepare('SELECT * FROM boq_lines WHERE boq_id = ? ORDER BY id').bind(boq.id).all()).results });
    if (req.method === 'PATCH') {
      const b = await body();
      const s = b.status;
      if (!['issued', 'accepted', 'rejected'].includes(s)) return json({ error: 'Invalid status' }, 400);
      if (boq.status === 'pending_approval') {
        // only an admin can decide an over-limit discount, and only as approve (issue) or reject
        if (!admin) return json({ error: 'Waiting for admin approval' }, 403);
        if (s === 'accepted') return json({ error: 'Approve or reject first' }, 400);
        await db.batch([
          db.prepare(`UPDATE boqs SET status = ?, decided_by = ?, decided_at = datetime('now'), decision_note = ?, issued_on = ? WHERE id = ?`)
            .bind(s, user.id, str(b.decision_note, 1000), todayIST(), boq.id),
          ...(s === 'issued' ? [db.prepare(BUMP_STAGE).bind(boq.lead_id)] : []),
        ]);
        return json({ ok: true });
      }
      await db.prepare('UPDATE boqs SET status = ? WHERE id = ?').bind(s, boq.id).run();
      return json({ ok: true });
    }
  }

  // ---- price list (everyone reads, admin writes; every price or cap change is logged)
  if (p === '/api/products' && req.method === 'GET')
    return json((await db.prepare(`SELECT * FROM products ${admin ? '' : 'WHERE active = 1'} ORDER BY brand, name`).all()).results);
  const histM = p.match(/^\/api\/products\/(\d+)\/history$/);
  if (histM && req.method === 'GET')
    return json((await db.prepare(`SELECT h.*, u.name user_name FROM price_history h LEFT JOIN users u ON u.id = h.user_id WHERE h.product_id = ? ORDER BY h.id DESC LIMIT 200`)
      .bind(Number(histM[1])).all()).results);

  if (!admin) return json({ error: 'admin only' }, 403);
  const prodFields = (b: Record<string, any>) => ({ sku: str(b.sku, 60), name: str(b.name, 200), brand: str(b.brand, 80),
    unit_price: num(b.unit_price), max_discount_pct: Math.min(100, Math.max(0, num(b.max_discount_pct) ?? 0)), active: b.active === false ? 0 : 1 });
  const logPrice = (cur: Record<string, any>, f: { unit_price: number | null; max_discount_pct: number }) =>
    db.prepare('INSERT INTO price_history (product_id, user_id, old_price, new_price, old_cap, new_cap) VALUES (?,?,?,?,?,?)')
      .bind(cur.id, user.id, cur.unit_price, f.unit_price, cur.max_discount_pct, f.max_discount_pct);
  const insertProduct = (f: ReturnType<typeof prodFields>) => [
    db.prepare('INSERT INTO products (sku, name, brand, unit_price, max_discount_pct, active) VALUES (?,?,?,?,?,?)').bind(f.sku, f.name, f.brand, f.unit_price, f.max_discount_pct, f.active),
    db.prepare(`INSERT INTO price_history (product_id, user_id, new_price, new_cap) VALUES ((SELECT id FROM products WHERE sku = ?), ?, ?, ?)`).bind(f.sku, user.id, f.unit_price, f.max_discount_pct),
  ];
  const updateProduct = (cur: Record<string, any>, f: ReturnType<typeof prodFields>) => [
    db.prepare(`UPDATE products SET sku=?, name=?, brand=?, unit_price=?, max_discount_pct=?, active=?, updated_at=datetime('now') WHERE id=?`)
      .bind(f.sku, f.name, f.brand, f.unit_price, f.max_discount_pct, f.active, cur.id),
    ...(f.unit_price !== cur.unit_price || f.max_discount_pct !== cur.max_discount_pct ? [logPrice(cur, f)] : []),
  ];
  const badProduct = (f: ReturnType<typeof prodFields>) => !f.sku || !f.name || f.unit_price === null || f.unit_price < 0;

  if (p === '/api/products' && req.method === 'POST') {
    const f = prodFields(await body());
    if (badProduct(f)) return json({ error: 'SKU, name and a valid price are required' }, 400);
    try { await db.batch(insertProduct(f)); } catch { return json({ error: 'SKU already exists' }, 409); }
    return json({ ok: true });
  }
  // Bulk load from a spreadsheet: rows are matched on SKU, new SKUs are added, existing ones updated.
  if (p === '/api/products/import' && req.method === 'POST') {
    const rows = (await body()).rows;
    if (!Array.isArray(rows) || !rows.length || rows.length > 2000) return json({ error: 'Send 1 to 2000 rows' }, 400);
    const bySku = new Map((await db.prepare('SELECT * FROM products').all<Record<string, any>>()).results.map((x) => [String(x.sku).toLowerCase(), x]));
    const stmts: D1PreparedStatement[] = [];
    const errors: string[] = [];
    const seen = new Set<string>();
    let created = 0, updated = 0;
    rows.forEach((r: Record<string, any>, i: number) => {
      const key = String(r?.sku ?? '').trim().toLowerCase();
      if (seen.has(key)) return void errors.push(`Row ${i + 1}: SKU ${key} appears twice in the file`);
      seen.add(key);
      const cur = bySku.get(key);
      const f = prodFields({ ...(cur ? { ...cur, active: cur.active === 1 } : {}), ...r, sku: cur?.sku ?? r?.sku });
      if (badProduct(f)) return void errors.push(`Row ${i + 1}: SKU, name and a valid price are required`);
      if (cur) { stmts.push(...updateProduct(cur, f)); updated++; }
      else { stmts.push(...insertProduct(f)); created++; }
    });
    if (errors.length) return json({ error: errors.slice(0, 5).join('; ') + (errors.length > 5 ? ` (+${errors.length - 5} more)` : '') }, 400);
    for (let i = 0; i < stmts.length; i += 90) await db.batch(stmts.slice(i, i + 90)); // D1 caps statements per batch
    return json({ created, updated });
  }
  const prodM = p.match(/^\/api\/products\/(\d+)$/);
  if (prodM && req.method === 'PATCH') {
    const cur = await db.prepare('SELECT * FROM products WHERE id = ?').bind(Number(prodM[1])).first<Record<string, any>>();
    if (!cur) return json({ error: 'not found' }, 404);
    const f = prodFields({ ...cur, active: cur.active === 1, ...(await body()) });
    if (badProduct(f)) return json({ error: 'SKU, name and a valid price are required' }, 400);
    try { await db.batch(updateProduct(cur, f)); } catch { return json({ error: 'SKU already exists' }, 409); }
    return json({ ok: true });
  }
  if (p === '/api/users' && req.method === 'GET') return listUsers(db);
  if (p === '/api/users' && req.method === 'POST') return createUser(db, await body());
  const userM = p.match(/^\/api\/users\/(\d+)$/);
  if (userM && req.method === 'PATCH') return updateUser(db, Number(userM[1]), await body());
  if (p === '/api/demo' && req.method === 'GET') return json(await demoStatus(db));
  if (p === '/api/demo' && req.method === 'POST') { const r = await loadDemo(db, user); return json(r, 'error' in r ? 409 : 200); }
  if (p === '/api/demo' && req.method === 'DELETE') return json(await clearDemo(db));
  if (p === '/api/send-reminders' && req.method === 'POST') return json(await sendReminders(env));
  return json({ error: 'not found' }, 404);
}

// Daily: each salesperson gets their overdue + today's follow-ups.
export async function sendReminders(env: Env) {
  await ensureSchema(env.DB);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM login_fails WHERE at < datetime('now', '-1 day')`),
    env.DB.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`),
  ]);
  const today = todayIST();
  const { results } = await env.DB.prepare(`SELECT l.id, l.company, l.contact, l.phone, l.stage, l.next_followup, u.email, u.name
    FROM leads l JOIN users u ON u.id = l.owner_id WHERE u.active = 1 AND u.email NOT LIKE ? AND l.next_followup <= ? AND l.stage NOT IN ('won','lost')
    ORDER BY u.email, l.next_followup`).bind('%' + DEMO_DOMAIN, today).all<Record<string, string>>();
  const byUser = new Map<string, Record<string, string>[]>();
  for (const r of results) byUser.set(r.email, [...(byUser.get(r.email) ?? []), r]);
  let sent = 0;
  const failed: string[] = [];
  for (const [email, leads] of byUser) {
    const rows = leads.map((l) => `<tr><td><a href="https://sales.vtech.services/#lead/${l.id}">${esc(l.company)}</a></td><td>${esc(l.contact)}</td>
      <td>${esc(l.phone)}</td><td>${esc(l.stage)}</td><td style="color:${l.next_followup < today ? '#b91c1c' : 'inherit'}">${esc(l.next_followup)}</td></tr>`).join('');
    const html = `<p>Hi ${esc(leads[0].name)}, you have ${leads.length} follow-up(s) due.</p>
      <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:Arial;font-size:13px">
      <tr style="background:#eee"><th>Company</th><th>Contact</th><th>Phone</th><th>Stage</th><th>Due</th></tr>${rows}</table>`;
    try {
      await sendMail(env.MAILER, env.MAIL_FROM, 'VTech Sales Tracker', email, `Follow-ups due: ${leads.length} (${today})`, html);
      sent++;
    } catch (e) {
      console.error('reminder failed', email, e);
      failed.push(email);
    }
  }
  return { users: byUser.size, sent, failed };
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      await ensureSchema(env.DB);
      return await api(req, env, url, ctx);
    } catch (e) {
      console.error(e);
      return json({ error: 'server error' }, 500);
    }
  },
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(sendReminders(env));
  },
} satisfies ExportedHandler<Env>;
