// Email + password auth on D1. PBKDF2-SHA256 (100k iterations, Workers' max), random session tokens
// stored hashed, HttpOnly cookie. First account can only be created for ADMIN_EMAIL via /api/setup.

export interface User { id: number; email: string; name: string; role: 'admin' | 'member' }

const COOKIE = 'vt_session';
const SESSION_DAYS = 30;
const enc = new TextEncoder();

const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const randomHex = (n: number) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s: string) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

export async function hashPassword(password: string, saltHex = randomHex(16)) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = new Uint8Array(saltHex.match(/../g)!.map((h) => parseInt(h, 16)));
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 }, key, 256);
  return { salt: saltHex, hash: hex(bits) };
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export const AUTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL COLLATE NOCASE, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','member')), pw_salt TEXT NOT NULL, pw_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL);`;

export async function currentUser(db: D1Database, req: Request): Promise<User | null> {
  const token = req.headers.get('cookie')?.match(new RegExp(`${COOKIE}=([a-f0-9]{64})`))?.[1];
  if (!token) return null;
  return db
    .prepare(`SELECT u.id, u.email, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
              WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND u.active = 1`)
    .bind(await sha256(token))
    .first<User>();
}

async function startSession(db: D1Database, userId: number) {
  const token = randomHex(32);
  await db
    .prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))`)
    .bind(await sha256(token), userId)
    .run();
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(data, { status, headers });

export async function login(db: D1Database, body: { email?: string; password?: string }) {
  const email = String(body.email ?? '').trim();
  const row = await db
    .prepare('SELECT id, pw_salt, pw_hash FROM users WHERE email = ? AND active = 1')
    .bind(email)
    .first<{ id: number; pw_salt: string; pw_hash: string }>();
  // Hash even when the user is missing so response time doesn't reveal which emails exist.
  const { hash } = await hashPassword(String(body.password ?? ''), row?.pw_salt ?? '00'.repeat(16));
  if (!row || !safeEqual(hash, row.pw_hash)) return json({ error: 'Invalid email or password' }, 401);
  return json({ ok: true }, 200, { 'set-cookie': await startSession(db, row.id) });
}

export async function logout(db: D1Database, req: Request) {
  const token = req.headers.get('cookie')?.match(new RegExp(`${COOKIE}=([a-f0-9]{64})`))?.[1];
  if (token) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
}

export async function setup(db: D1Database, adminEmail: string, body: { email?: string; name?: string; password?: string }) {
  const count = await db.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  if (count!.n > 0) return json({ error: 'Already set up' }, 409);
  const email = String(body.email ?? '').trim();
  if (email.toLowerCase() !== adminEmail.toLowerCase()) return json({ error: 'Only the configured admin email can run setup' }, 403);
  return createUser(db, { email, name: body.name ?? 'Admin', password: body.password, role: 'admin' });
}

export async function createUser(db: D1Database, b: { email?: string; name?: string; password?: string; role?: string }) {
  const email = String(b.email ?? '').trim();
  const name = String(b.name ?? '').trim();
  const password = String(b.password ?? '');
  const role = b.role === 'admin' ? 'admin' : 'member';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'Valid email required' }, 400);
  if (!name) return json({ error: 'Name required' }, 400);
  if (password.length < 10) return json({ error: 'Password must be at least 10 characters' }, 400);
  const { salt, hash } = await hashPassword(password);
  try {
    await db.prepare('INSERT INTO users (email, name, role, pw_salt, pw_hash) VALUES (?, ?, ?, ?, ?)').bind(email, name, role, salt, hash).run();
  } catch {
    return json({ error: 'Email already exists' }, 409);
  }
  return json({ ok: true });
}

export async function updateUser(db: D1Database, id: number, b: { name?: string; role?: string; active?: boolean; password?: string }) {
  if (b.password !== undefined) {
    if (String(b.password).length < 10) return json({ error: 'Password must be at least 10 characters' }, 400);
    const { salt, hash } = await hashPassword(String(b.password));
    await db.prepare('UPDATE users SET pw_salt = ?, pw_hash = ? WHERE id = ?').bind(salt, hash, id).run();
    await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run();
  }
  if (b.name !== undefined) await db.prepare('UPDATE users SET name = ? WHERE id = ?').bind(String(b.name).trim(), id).run();
  if (b.role !== undefined) await db.prepare('UPDATE users SET role = ? WHERE id = ?').bind(b.role === 'admin' ? 'admin' : 'member', id).run();
  if (b.active !== undefined) {
    await db.prepare('UPDATE users SET active = ? WHERE id = ?').bind(b.active ? 1 : 0, id).run();
    if (!b.active) await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run();
  }
  return json({ ok: true });
}

export async function listUsers(db: D1Database) {
  const { results } = await db.prepare('SELECT id, email, name, role, active, created_at FROM users ORDER BY name').all();
  return json(results);
}
