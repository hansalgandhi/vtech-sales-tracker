// VTech Sales Tracker — lead tracking per salesperson, interactions, follow-up reminders, BOQs issued,
// and an admin-controlled price list with per-product discount caps. Cloudflare Worker + D1.
import { AUTH_SCHEMA, currentUser, login, logout, setup, createUser, updateUser, listUsers, type User } from './auth';
import { sendMail, esc } from './mail';

export interface Env { DB: D1Database; ASSETS: Fetcher; MAILER: SendEmail; ADMIN_EMAIL: string; MAIL_FROM: string }

const STAGES = ['new', 'contacted', 'site_visit', 'boq_sent', 'negotiation', 'won', 'lost'] as const;
const KINDS = ['call', 'meeting', 'site_visit', 'email', 'whatsapp', 'note'] as const;
const BOQ_STATUS = ['draft', 'issued', 'accepted', 'rejected'] as const;

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
CREATE TABLE IF NOT EXISTS boqs (id INTEGER PRIMARY KEY, lead_id INTEGER NOT NULL REFERENCES leads(id), user_id INTEGER NOT NULL REFERENCES users(id),
  ref TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'issued', issued_on TEXT NOT NULL DEFAULT (date('now', '+330 minutes')),
  total REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS boq_lines (id INTEGER PRIMARY KEY, boq_id INTEGER NOT NULL REFERENCES boqs(id), product_id INTEGER REFERENCES products(id),
  description TEXT NOT NULL, qty REAL NOT NULL, unit_price REAL NOT NULL, discount_pct REAL NOT NULL DEFAULT 0, line_total REAL NOT NULL)`;

let ready = false;
async function ensureSchema(db: D1Database) {
  if (ready) return;
  await db.batch(SCHEMA.split(';').map((s) => s.trim()).filter(Boolean).map((s) => db.prepare(s)));
  ready = true;
}

const json = (d: unknown, status = 200) => Response.json(d, { status });
const str = (v: unknown, max = 500) => (v === undefined || v === null || v === '' ? null : String(v).trim().slice(0, max));
const num = (v: unknown) => (v === undefined || v === null || v === '' || isNaN(Number(v)) ? null : Number(v));
const date = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const todayIST = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

async function leadFor(db: D1Database, user: User, id: number) {
  const lead = await db.prepare('SELECT * FROM leads WHERE id = ?').bind(id).first<Record<string, any>>();
  if (!lead || (user.role !== 'admin' && lead.owner_id !== user.id)) return null;
  return lead;
}

async function api(req: Request, env: Env, url: URL): Promise<Response> {
  const db = env.DB;
  const p = url.pathname;
  const body = async () => (await req.json().catch(() => ({}))) as Record<string, any>;

  if (p === '/api/login' && req.method === 'POST') return login(db, await body());
  if (p === '/api/setup' && req.method === 'POST') return setup(db, env.ADMIN_EMAIL, await body());
  if (p === '/api/needs-setup') return json({ needsSetup: (await db.prepare('SELECT COUNT(*) n FROM users').first<{ n: number }>())!.n === 0 });

  const user = await currentUser(db, req);
  if (!user) return json({ error: 'unauthorized' }, 401);
  const admin = user.role === 'admin';
  if (p === '/api/logout') return logout(db, req);
  if (p === '/api/me') return json(user);
  if (p === '/api/meta') return json({ stages: STAGES, kinds: KINDS, boqStatus: BOQ_STATUS,
    users: (await db.prepare('SELECT id, name FROM users WHERE active = 1 ORDER BY name').all()).results });

  // ---- dashboard
  if (p === '/api/dashboard') {
    const scope = admin ? '1=1' : 'owner_id = ?1';
    const [byStage, due, byOwner] = await db.batch([
      db.prepare(`SELECT stage, COUNT(*) n, COALESCE(SUM(est_value),0) value FROM leads WHERE ${scope} GROUP BY stage`).bind(...(admin ? [] : [user.id])),
      db.prepare(`SELECT COUNT(*) n FROM leads WHERE ${scope} AND next_followup <= ?${admin ? 1 : 2} AND stage NOT IN ('won','lost')`).bind(...(admin ? [todayIST()] : [user.id, todayIST()])),
      db.prepare(`SELECT u.name, COUNT(l.id) leads, SUM(CASE WHEN l.stage='won' THEN COALESCE(l.est_value,0) END) won_value
                  FROM users u LEFT JOIN leads l ON l.owner_id = u.id WHERE u.active = 1 ${admin ? '' : 'AND u.id = ?1'} GROUP BY u.id ORDER BY leads DESC`).bind(...(admin ? [] : [user.id])),
    ]);
    return json({ byStage: byStage.results, due: (due.results[0] as { n: number }).n, byOwner: byOwner.results });
  }

  // ---- leads
  if (p === '/api/leads' && req.method === 'GET') {
    const q = `%${url.searchParams.get('q') ?? ''}%`;
    const stage = url.searchParams.get('stage') ?? '';
    const owner = admin ? Number(url.searchParams.get('owner') || 0) : user.id;
    const dueOnly = url.searchParams.get('due') === '1' ? 1 : 0;
    const { results } = await db.prepare(`SELECT l.*, u.name owner_name,
        (SELECT COUNT(*) FROM boqs b WHERE b.lead_id = l.id) boq_count FROM leads l JOIN users u ON u.id = l.owner_id
        WHERE (l.company LIKE ?1 OR l.contact LIKE ?1 OR l.phone LIKE ?1 OR l.city LIKE ?1) AND (?2 = '' OR l.stage = ?2)
          AND (?3 = 0 OR l.owner_id = ?3) AND (?4 = 0 OR (l.next_followup <= ?5 AND l.stage NOT IN ('won','lost')))
        ORDER BY CASE WHEN l.next_followup IS NULL THEN 1 ELSE 0 END, l.next_followup, l.updated_at DESC LIMIT 500`)
      .bind(q, stage, owner, dueOnly, todayIST()).all();
    return json(results);
  }
  const leadFields = (b: Record<string, any>) => ({
    company: str(b.company, 200), contact: str(b.contact, 120), phone: str(b.phone, 40), email: str(b.email, 200), city: str(b.city, 80),
    source: str(b.source, 80), stage: STAGES.includes(b.stage) ? b.stage : null, est_value: num(b.est_value),
    next_followup: date(b.next_followup), notes: str(b.notes, 4000),
  });
  if (p === '/api/leads' && req.method === 'POST') {
    const f = leadFields(await body());
    if (!f.company) return json({ error: 'Company is required' }, 400);
    const r = await db.prepare(`INSERT INTO leads (owner_id, company, contact, phone, email, city, source, stage, est_value, next_followup, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id`).bind(user.id, f.company, f.contact, f.phone, f.email, f.city, f.source, f.stage ?? 'new',
      f.est_value, f.next_followup, f.notes).first<{ id: number }>();
    return json(r);
  }
  const leadM = p.match(/^\/api\/leads\/(\d+)(\/(interactions|boqs))?$/);
  if (leadM) {
    const lead = await leadFor(db, user, Number(leadM[1]));
    if (!lead) return json({ error: 'not found' }, 404);
    const sub = leadM[3];
    if (!sub && req.method === 'GET') {
      const [ints, boqs] = await db.batch([
        db.prepare('SELECT i.*, u.name user_name FROM interactions i JOIN users u ON u.id = i.user_id WHERE lead_id = ? ORDER BY i.at DESC').bind(lead.id),
        db.prepare('SELECT b.*, u.name user_name FROM boqs b JOIN users u ON u.id = b.user_id WHERE lead_id = ? ORDER BY b.id DESC').bind(lead.id),
      ]);
      return json({ ...lead, interactions: ints.results, boqs: boqs.results });
    }
    if (!sub && req.method === 'PATCH') {
      const b = await body();
      const f = leadFields({ ...lead, ...b });
      if (!f.company) return json({ error: 'Company is required' }, 400);
      const owner = admin && num(b.owner_id) ? num(b.owner_id) : lead.owner_id;
      await db.prepare(`UPDATE leads SET company=?, contact=?, phone=?, email=?, city=?, source=?, stage=?, est_value=?, next_followup=?,
        notes=?, owner_id=?, updated_at=datetime('now') WHERE id=?`).bind(f.company, f.contact, f.phone, f.email, f.city, f.source,
        f.stage ?? lead.stage, f.est_value, f.next_followup, f.notes, owner, lead.id).run();
      return json({ ok: true });
    }
    if (sub === 'interactions' && req.method === 'POST') {
      const b = await body();
      if (!KINDS.includes(b.kind)) return json({ error: 'Invalid interaction type' }, 400);
      const stmts = [db.prepare('INSERT INTO interactions (lead_id, user_id, kind, note) VALUES (?,?,?,?)').bind(lead.id, user.id, b.kind, str(b.note, 4000))];
      const next = date(b.next_followup);
      stmts.push(db.prepare(`UPDATE leads SET next_followup = ?, stage = COALESCE(?, stage), updated_at = datetime('now') WHERE id = ?`)
        .bind(next, STAGES.includes(b.stage) ? b.stage : null, lead.id));
      await db.batch(stmts);
      return json({ ok: true });
    }
    if (sub === 'boqs' && req.method === 'POST') {
      const b = await body();
      const lines = Array.isArray(b.lines) ? b.lines : [];
      if (!lines.length) return json({ error: 'Add at least one line' }, 400);
      const priced = [];
      for (const l of lines) {
        const qty = num(l.qty);
        if (!qty || qty <= 0) return json({ error: 'Each line needs a quantity' }, 400);
        const disc = Math.max(0, num(l.discount_pct) ?? 0);
        let unit = num(l.unit_price), desc = str(l.description, 300), pid: number | null = null;
        if (num(l.product_id)) {
          const prod = await db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').bind(num(l.product_id)).first<Record<string, any>>();
          if (!prod) return json({ error: 'Unknown product on a line' }, 400);
          if (!admin && disc > prod.max_discount_pct) return json({ error: `${prod.name}: discount ${disc}% exceeds the ${prod.max_discount_pct}% cap` }, 400);
          pid = prod.id; unit = prod.unit_price; desc = desc ?? `${prod.sku} — ${prod.name}`;
        } else if (!admin) return json({ error: 'Only admins can add lines outside the price list' }, 400);
        if (unit === null || !desc) return json({ error: 'Each line needs a description and price' }, 400);
        if (disc > 100) return json({ error: 'Discount cannot exceed 100%' }, 400);
        priced.push({ pid, desc, qty, unit, disc, total: Math.round(qty * unit * (1 - disc / 100) * 100) / 100 });
      }
      const total = priced.reduce((s, l) => s + l.total, 0);
      const count = await db.prepare('SELECT COUNT(*) n FROM boqs').first<{ n: number }>();
      const ref = str(b.ref, 60) ?? `VT-BOQ-${todayIST().replace(/-/g, '')}-${count!.n + 1}`;
      const boq = await db.prepare('INSERT INTO boqs (lead_id, user_id, ref, status, total) VALUES (?,?,?,?,?) RETURNING id')
        .bind(lead.id, user.id, ref, BOQ_STATUS.includes(b.status) ? b.status : 'issued', total).first<{ id: number }>();
      await db.batch([
        ...priced.map((l) => db.prepare('INSERT INTO boq_lines (boq_id, product_id, description, qty, unit_price, discount_pct, line_total) VALUES (?,?,?,?,?,?,?)')
          .bind(boq!.id, l.pid, l.desc, l.qty, l.unit, l.disc, l.total)),
        db.prepare(`UPDATE leads SET stage = CASE WHEN stage IN ('new','contacted','site_visit') THEN 'boq_sent' ELSE stage END, updated_at = datetime('now') WHERE id = ?`).bind(lead.id),
      ]);
      return json({ id: boq!.id, ref, total });
    }
  }
  const boqM = p.match(/^\/api\/boqs\/(\d+)$/);
  if (boqM) {
    const boq = await db.prepare('SELECT * FROM boqs WHERE id = ?').bind(Number(boqM[1])).first<Record<string, any>>();
    if (!boq || !(await leadFor(db, user, boq.lead_id))) return json({ error: 'not found' }, 404);
    if (req.method === 'GET') return json({ ...boq, lines: (await db.prepare('SELECT * FROM boq_lines WHERE boq_id = ?').bind(boq.id).all()).results });
    if (req.method === 'PATCH') {
      const s = (await body()).status;
      if (!BOQ_STATUS.includes(s)) return json({ error: 'Invalid status' }, 400);
      await db.prepare('UPDATE boqs SET status = ? WHERE id = ?').bind(s, boq.id).run();
      return json({ ok: true });
    }
  }

  // ---- price list (everyone reads, admin writes)
  if (p === '/api/products' && req.method === 'GET')
    return json((await db.prepare(`SELECT * FROM products ${admin ? '' : 'WHERE active = 1'} ORDER BY brand, name`).all()).results);

  if (!admin) return json({ error: 'admin only' }, 403);
  const prodFields = (b: Record<string, any>) => ({ sku: str(b.sku, 60), name: str(b.name, 200), brand: str(b.brand, 80),
    unit_price: num(b.unit_price), max_discount_pct: Math.min(100, Math.max(0, num(b.max_discount_pct) ?? 0)), active: b.active === false ? 0 : 1 });
  if (p === '/api/products' && req.method === 'POST') {
    const f = prodFields(await body());
    if (!f.sku || !f.name || f.unit_price === null || f.unit_price < 0) return json({ error: 'SKU, name and a valid price are required' }, 400);
    try {
      await db.prepare('INSERT INTO products (sku, name, brand, unit_price, max_discount_pct, active) VALUES (?,?,?,?,?,?)')
        .bind(f.sku, f.name, f.brand, f.unit_price, f.max_discount_pct, f.active).run();
    } catch { return json({ error: 'SKU already exists' }, 409); }
    return json({ ok: true });
  }
  const prodM = p.match(/^\/api\/products\/(\d+)$/);
  if (prodM && req.method === 'PATCH') {
    const cur = await db.prepare('SELECT * FROM products WHERE id = ?').bind(Number(prodM[1])).first<Record<string, any>>();
    if (!cur) return json({ error: 'not found' }, 404);
    const f = prodFields({ ...cur, active: cur.active === 1, ...(await body()) });
    if (!f.sku || !f.name || f.unit_price === null || f.unit_price < 0) return json({ error: 'SKU, name and a valid price are required' }, 400);
    await db.prepare(`UPDATE products SET sku=?, name=?, brand=?, unit_price=?, max_discount_pct=?, active=?, updated_at=datetime('now') WHERE id=?`)
      .bind(f.sku, f.name, f.brand, f.unit_price, f.max_discount_pct, f.active, cur.id).run();
    return json({ ok: true });
  }
  if (p === '/api/users' && req.method === 'GET') return listUsers(db);
  if (p === '/api/users' && req.method === 'POST') return createUser(db, await body());
  const userM = p.match(/^\/api\/users\/(\d+)$/);
  if (userM && req.method === 'PATCH') return updateUser(db, Number(userM[1]), await body());
  if (p === '/api/send-reminders' && req.method === 'POST') return json(await sendReminders(env));
  return json({ error: 'not found' }, 404);
}

// Daily: each salesperson gets their overdue + today's follow-ups.
export async function sendReminders(env: Env) {
  await ensureSchema(env.DB);
  const today = todayIST();
  const { results } = await env.DB.prepare(`SELECT l.id, l.company, l.contact, l.phone, l.stage, l.next_followup, u.email, u.name
    FROM leads l JOIN users u ON u.id = l.owner_id WHERE u.active = 1 AND l.next_followup <= ? AND l.stage NOT IN ('won','lost')
    ORDER BY u.email, l.next_followup`).bind(today).all<Record<string, string>>();
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
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    await ensureSchema(env.DB);
    try {
      return await api(req, env, url);
    } catch (e) {
      console.error(e);
      return json({ error: 'server error' }, 500);
    }
  },
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(sendReminders(env));
  },
} satisfies ExportedHandler<Env>;
