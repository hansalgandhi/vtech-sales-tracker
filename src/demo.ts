// Sample data for demonstrations: four salespeople, a price list, leads at every stage, interaction history and BOQs
// (including two waiting for discount approval). Loaded and removed by an admin from the Users page.
// Everything it creates is recorded in demo_rows, so removing it never touches real records.
import { hashPassword, type User } from './auth';

export const DEMO_DOMAIN = '@demo.vtech.services';
export const DEMO_SCHEMA = `CREATE TABLE IF NOT EXISTS demo_rows (tbl TEXT NOT NULL, id INTEGER NOT NULL, PRIMARY KEY (tbl, id))`;
const TABLES = ['users', 'products', 'leads', 'interactions', 'boqs', 'boq_lines', 'price_history'] as const;

// name, discount limit %
const REPS: [string, number][] = [['Rohan Mehta', 5], ['Priya Nair', 5], ['Amit Kulkarni', 8], ['Sneha Joshi', 10]];
const repEmail = (i: number) => REPS[i][0].split(' ')[0].toLowerCase() + DEMO_DOMAIN;

// sku, name, brand, list price (₹, illustrative), max discount %
const PRODUCTS: [string, string, string, number, number][] = [
  ['TSW-770', '7" touch screen', 'Crestron', 145000, 8],
  ['MC4', '4-Series control processor', 'Crestron', 165000, 8],
  ['HZ2-KPCN', 'Horizon keypad', 'Crestron', 32000, 10],
  ['DM-NVX-360', 'AV-over-IP encoder/decoder', 'Crestron', 185000, 6],
  ['DIN-8SW8', '8-channel switch module', 'Crestron', 78000, 8],
  ['HQP7-RF-2', 'HomeWorks QSX processor', 'Lutron', 210000, 6],
  ['HQWT-PALL-4B', 'Palladiom 4-button keypad', 'Lutron', 54000, 8],
  ['QSYC-SHADE', 'Sivoia QS roller shade drive', 'Lutron', 68000, 10],
  ['SONESSE-40', 'Motorised curtain track motor', 'Somfy', 38000, 12],
  ['SONOS-AMP', 'Amp (streaming amplifier)', 'Sonos', 79000, 5],
  ['DM3C', 'DesignMax ceiling speaker (pair)', 'Bose', 28000, 12],
  ['C26CT', 'Control 26CT ceiling speaker (pair)', 'JBL', 16500, 15],
  ['AVR-X3800H', '9.4-channel AV receiver', 'Denon', 165000, 7],
  ['EH-LS12000B', '4K laser projector', 'Epson', 485000, 5],
  ['EH-TW7100', '4K home projector', 'Epson', 175000, 6],
  ['SCR-120-ALR', '120" ALR fixed-frame screen', 'Elite Screens', 95000, 12],
  ['QA75Q60D', '75" QLED display', 'Samsung', 155000, 6],
  ['QA65Q60D', '65" QLED display', 'Samsung', 98000, 6],
  ['RALLY-BAR', 'Rally Bar video conferencing', 'Logitech', 420000, 6],
  ['STUDIO-X50', 'Studio X50 video bar', 'Poly', 265000, 6],
  ['MXA920', 'Ceiling array microphone', 'Shure', 480000, 5],
  ['TESIRAFORTE-AI', 'TesiraFORTE DSP', 'Biamp', 310000, 6],
  ['DS-2CD2143G2', '4 MP dome camera', 'Hikvision', 7800, 15],
  ['DS-7616NI', '16-channel NVR', 'Hikvision', 24500, 12],
  ['U6-PRO', 'Wi-Fi 6 access point', 'Ubiquiti', 16500, 10],
  ['USW-24-POE', '24-port PoE switch', 'Ubiquiti', 42000, 10],
  ['RACK-24U', '24U equipment rack with PDU', 'VTech', 28000, 15],
  ['CBL-SPK-14', 'Speaker cable 14 AWG (per metre)', 'VTech', 120, 20],
  ['CBL-HDMI-AOC15', '15 m optical HDMI cable', 'VTech', 9500, 15],
  ['SVC-PROG', 'Programming and commissioning (per day)', 'VTech', 18000, 0],
];
// Earlier prices, so the price history has something to show: sku, old price, days ago it changed
const PRICE_CHANGES: [string, number, number][] = [['TSW-770', 138000, 19], ['SONOS-AMP', 74000, 26], ['EH-LS12000B', 510000, 12], ['QA75Q60D', 162000, 33], ['MXA920', 465000, 8]];

type Lead = { company: string; contact: string; city: string; source: string; stage: string; value: number; rep: number; created: number; follow: number | null;
  needs: string; log: [number, string, string][] };
const LEADS: Lead[] = [
  { company: 'Orchid Heights – Penthouse 2101', contact: 'Mr. Karan Malhotra', city: 'Worli', source: 'Architect', stage: 'negotiation', value: 4200000, rep: 0, created: 38, follow: 1,
    needs: 'Full home automation for a 5 BHK: 42 lighting circuits, 14 motorised curtains, multi-room audio in 6 zones, home theatre 7.2.4. Wants Lutron keypads with Crestron control.',
    log: [[37, 'call', 'Architect introduced us. Client wants one app for everything.'], [30, 'site_visit', 'Walked the site with the architect, marked keypad and speaker positions.'], [21, 'email', 'Sent first BOQ.'],
      [14, 'meeting', 'Client finds the lighting package high. Asked us to rework with fewer keypads.'], [6, 'email', 'Sent revised BOQ.'], [2, 'call', 'Client comparing with one other integrator. Decision this week.']] },
  { company: 'Meridian Capital Advisors', contact: 'Ms. Anjali Rao', city: 'BKC', source: 'Referral', stage: 'boq_sent', value: 2800000, rep: 1, created: 25, follow: 0,
    needs: '12-seater boardroom and 2 huddle rooms. Teams-certified video conferencing, ceiling microphones, wireless presentation, room booking panels.',
    log: [[24, 'call', 'Referred by their IT vendor. Fit-out finishes next month.'], [17, 'site_visit', 'Measured the boardroom, checked ceiling void for the mic.'], [8, 'email', 'Sent BOQ.'], [3, 'whatsapp', 'Admin head says the CFO is reviewing. Follow up today.']] },
  { company: 'Saffron Hospitality – Juhu', contact: 'Mr. Vikram Sethi', city: 'Juhu', source: 'Existing client', stage: 'site_visit', value: 6500000, rep: 2, created: 14, follow: 3,
    needs: 'Banquet hall AV: 2 projectors, main PA, stage lighting control, background music in the lobby and restaurant.',
    log: [[13, 'call', 'Repeat client. New banquet hall opening before the wedding season.'], [4, 'site_visit', 'Surveyed the hall with their operations head. Rigging points to be confirmed by the contractor.']] },
  { company: "Dr. Kapoor's Dental Studio", contact: 'Dr. Neha Kapoor', city: 'Bandra West', source: 'Walk-in', stage: 'won', value: 650000, rep: 0, created: 44, follow: null,
    needs: 'Waiting-room display, background music in 4 cabins, 8 CCTV cameras.',
    log: [[43, 'meeting', 'Walked in to the experience centre. Small job, quick decision expected.'], [36, 'email', 'Sent BOQ.'], [31, 'call', 'Order confirmed. Advance received.']] },
  { company: 'Bluepeak Logistics HQ', contact: 'Mr. Arvind Pillai', city: 'Navi Mumbai', source: 'Website', stage: 'contacted', value: 1800000, rep: 3, created: 9, follow: -2,
    needs: 'Town-hall room for 80 people, 3 meeting rooms, digital signage at reception.',
    log: [[9, 'email', 'Enquiry from the website form.'], [5, 'call', 'Spoke to the facilities manager. He will share the floor plan.']] },
  { company: 'The Banyan Villa, Alibaug', contact: 'Mrs. Rekha Desai', city: 'Alibaug', source: 'Architect', stage: 'boq_sent', value: 5200000, rep: 2, created: 30, follow: -1,
    needs: 'Weekend villa: outdoor audio, pool-side lighting scenes, 4K home theatre, full Wi-Fi coverage and CCTV.',
    log: [[29, 'meeting', 'Met the client with the architect.'], [20, 'site_visit', 'Site visit to Alibaug. Sea air: outdoor speakers must be marine grade.'], [12, 'email', 'Sent BOQ after discount approval.'], [8, 'call', 'Client travelling, asked us to call back after the 23rd.']] },
  { company: 'Northlight Co-working, Powai', contact: 'Mr. Farhan Sheikh', city: 'Powai', source: 'Referral', stage: 'new', value: 1200000, rep: 1, created: 2, follow: 2,
    needs: '6 meeting rooms with booking panels and video bars. Background music in common areas.',
    log: [[2, 'call', 'First call. They open a second floor in January.']] },
  { company: 'Greenfield International School', contact: 'Ms. Lata Iyer', city: 'Thane', source: 'Tender', stage: 'negotiation', value: 3600000, rep: 3, created: 35, follow: 0,
    needs: 'Auditorium AV for 300 seats and 20 smart classrooms with interactive displays.',
    log: [[34, 'meeting', 'Pre-bid meeting with the trust.'], [26, 'site_visit', 'Auditorium survey. Long throw: needs the laser projector.'], [18, 'email', 'Sent BOQ.'], [9, 'meeting', 'Trust asked for education pricing on microphones.'], [3, 'email', 'Sent revised BOQ.'], [1, 'call', 'They want a further discount on the ceiling mic. Sent for approval.']] },
  { company: 'Sharma Residence – Pali Hill', contact: 'Mr. Rajat Sharma', city: 'Bandra West', source: 'Existing client', stage: 'won', value: 2400000, rep: 0, created: 50, follow: null,
    needs: 'Lighting and curtain automation for a 3 BHK, living-room media wall, 2 audio zones.',
    log: [[49, 'call', 'Past client, new flat.'], [40, 'email', 'Sent BOQ.'], [33, 'meeting', 'Order confirmed at the experience centre.']] },
  { company: 'Aurum Jewels Showroom', contact: 'Mr. Deepak Soni', city: 'Zaveri Bazaar', source: 'Walk-in', stage: 'lost', value: 900000, rep: 1, created: 40, follow: null,
    needs: 'Showroom lighting scenes, 16 CCTV cameras, background music.',
    log: [[39, 'site_visit', 'Visited the showroom.'], [30, 'email', 'Sent BOQ.'], [22, 'call', 'Lost on price. They went with their electrician for CCTV only.']] },
  { company: 'Vertex Pharma – Training Centre', contact: 'Ms. Pooja Menon', city: 'Andheri East', source: 'Website', stage: 'site_visit', value: 2200000, rep: 2, created: 12, follow: 5,
    needs: 'Divisible training room, 2 projectors, lecture capture, wireless microphones.',
    log: [[11, 'call', 'Discussed requirement with the L&D head.'], [3, 'site_visit', 'Survey done. Partition wall means two independent systems that can combine.']] },
  { company: 'Skyline Developers – Sample Flat', contact: 'Mr. Nikhil Jain', city: 'Lower Parel', source: 'Builder', stage: 'boq_sent', value: 1500000, rep: 3, created: 20, follow: 1,
    needs: 'Show-flat automation to demonstrate to buyers: lighting, curtains, voice control, video door phone.',
    log: [[19, 'meeting', 'Met the marketing head. If the sample flat works they will offer it as a buyer upgrade.'], [11, 'site_visit', 'Sample flat survey.'], [5, 'email', 'Sent BOQ.']] },
  { company: 'Café Mocha Mill', contact: "Ms. Tara D'Souza", city: 'Khar', source: 'Walk-in', stage: 'contacted', value: 350000, rep: 1, created: 18, follow: -6,
    needs: 'Background music with zones and 2 displays for the menu.',
    log: [[18, 'meeting', 'Owner visited the experience centre.'], [11, 'whatsapp', 'Shared speaker options. No reply yet.']] },
  { company: 'Patel Family Home Theatre', contact: 'Mr. Hitesh Patel', city: 'Borivali', source: 'Referral', stage: 'negotiation', value: 1100000, rep: 0, created: 22, follow: 2,
    needs: 'Dedicated 12-seat theatre, Atmos 7.2.4. Acoustic treatment by others.',
    log: [[21, 'call', 'Referred by the Sharma family.'], [15, 'site_visit', 'Room is 22 x 14 ft. Projector throw is fine.'], [10, 'email', 'Sent BOQ.'], [0, 'call', 'Has a competitor quote that is lower on the projector. Asked for approval on a higher discount.']] },
  { company: 'Harbourview Clinic Chain', contact: 'Dr. Suresh Nambiar', city: 'Thane', source: 'Referral', stage: 'new', value: 800000, rep: 3, created: 1, follow: 4,
    needs: '5 clinics: queue display, CCTV and paging in each.',
    log: [[1, 'call', 'Introductory call. Wants one clinic done as a pilot.']] },
  { company: 'Zenith Law Chambers', contact: 'Adv. Meera Kulkarni', city: 'Fort', source: 'Referral', stage: 'contacted', value: 950000, rep: 2, created: 16, follow: -9,
    needs: 'Conference room video conferencing, document camera, sound masking.',
    log: [[16, 'call', 'Discussed requirement.'], [9, 'email', 'Sent company profile and references. Waiting for a site visit date.']] },
  { company: 'Lotus Yoga & Wellness', contact: 'Ms. Isha Bhatt', city: 'Juhu', source: 'Website', stage: 'lost', value: 400000, rep: 1, created: 33, follow: null,
    needs: 'Studio audio in 3 rooms with wireless headset microphones.',
    log: [[32, 'call', 'Budget is tight.'], [25, 'call', 'Project on hold. Marked lost.']] },
  { company: 'Trident Engineering Works', contact: 'Mr. Mahesh Gowda', city: 'Vasai', source: 'Referral', stage: 'site_visit', value: 1400000, rep: 3, created: 8, follow: 0,
    needs: 'Factory conference room, CCTV for 2 sheds, public address.',
    log: [[7, 'call', 'Referred by Bluepeak.'], [2, 'site_visit', 'Factory visit done. Draft BOQ due today.']] },
];

// ref suffix, lead index, days ago, status, lines [sku, qty, discount %], salesperson's note, admin's decision note
type Boq = { n: number; lead: number; ago: number; status: string; lines: [string, number, number][]; note?: string; decision?: string };
const BOQS: Boq[] = [
  { n: 1, lead: 0, ago: 21, status: 'rejected', lines: [['HQP7-RF-2', 1, 0], ['HQWT-PALL-4B', 22, 3], ['QSYC-SHADE', 14, 5], ['MC4', 1, 0], ['TSW-770', 3, 0], ['SONOS-AMP', 6, 0], ['DM3C', 12, 5], ['SVC-PROG', 8, 0]] },
  { n: 2, lead: 0, ago: 6, status: 'issued', lines: [['HQP7-RF-2', 1, 3], ['HQWT-PALL-4B', 16, 5], ['QSYC-SHADE', 14, 5], ['MC4', 1, 3], ['TSW-770', 2, 5], ['SONOS-AMP', 6, 3], ['DM3C', 12, 5], ['SVC-PROG', 8, 0]] },
  { n: 3, lead: 1, ago: 8, status: 'issued', lines: [['RALLY-BAR', 1, 4], ['MXA920', 1, 3], ['TESIRAFORTE-AI', 1, 4], ['QA75Q60D', 2, 5], ['STUDIO-X50', 2, 5], ['TSW-770', 3, 5], ['SVC-PROG', 3, 0]] },
  { n: 4, lead: 3, ago: 36, status: 'accepted', lines: [['QA65Q60D', 1, 5], ['SONOS-AMP', 2, 0], ['C26CT', 4, 5], ['DS-2CD2143G2', 8, 5], ['DS-7616NI', 1, 5], ['SVC-PROG', 1, 0]] },
  { n: 5, lead: 5, ago: 12, status: 'issued', decision: 'Approved as a one-off for the Alibaug villa. Do not repeat on Sonos.',
    note: 'Architect has promised two more villas on the same lane.',
    lines: [['EH-LS12000B', 1, 4], ['SCR-120-ALR', 1, 8], ['AVR-X3800H', 1, 5], ['SONOS-AMP', 5, 7], ['DM3C', 8, 8], ['U6-PRO', 9, 8], ['USW-24-POE', 1, 8], ['DS-2CD2143G2', 12, 8], ['DS-7616NI', 1, 8], ['SVC-PROG', 6, 0]] },
  { n: 6, lead: 7, ago: 18, status: 'rejected', lines: [['EH-LS12000B', 1, 0], ['MXA920', 2, 0], ['TESIRAFORTE-AI', 1, 3], ['QA75Q60D', 20, 5], ['SVC-PROG', 10, 0]] },
  { n: 7, lead: 7, ago: 3, status: 'issued', lines: [['EH-LS12000B', 1, 5], ['MXA920', 2, 5], ['TESIRAFORTE-AI', 1, 5], ['QA75Q60D', 20, 6], ['SVC-PROG', 10, 0]] },
  { n: 8, lead: 8, ago: 40, status: 'accepted', lines: [['MC4', 1, 3], ['HZ2-KPCN', 14, 5], ['DIN-8SW8', 4, 5], ['SONESSE-40', 8, 5], ['QA75Q60D', 1, 5], ['SONOS-AMP', 2, 3], ['DM3C', 4, 5], ['SVC-PROG', 4, 0]] },
  { n: 9, lead: 9, ago: 30, status: 'rejected', lines: [['DS-2CD2143G2', 16, 5], ['DS-7616NI', 1, 5], ['SONOS-AMP', 1, 0], ['C26CT', 6, 5], ['DIN-8SW8', 2, 5]] },
  { n: 10, lead: 11, ago: 5, status: 'issued', lines: [['MC4', 1, 5], ['HZ2-KPCN', 10, 8], ['SONESSE-40', 6, 10], ['TSW-770', 1, 5], ['SVC-PROG', 3, 0]] },
  { n: 11, lead: 13, ago: 10, status: 'issued', lines: [['EH-LS12000B', 1, 3], ['SCR-120-ALR', 1, 5], ['AVR-X3800H', 1, 5], ['C26CT', 4, 5], ['CBL-HDMI-AOC15', 1, 5], ['CBL-SPK-14', 180, 5], ['SVC-PROG', 2, 0]] },
  { n: 12, lead: 13, ago: 0, status: 'pending_approval', note: 'Client has a written competitor quote 8% lower on the projector. Repeat-referral family, I would like to match it.',
    lines: [['EH-LS12000B', 1, 9], ['SCR-120-ALR', 1, 5], ['AVR-X3800H', 1, 5], ['C26CT', 4, 5], ['CBL-HDMI-AOC15', 1, 5], ['CBL-SPK-14', 180, 5], ['SVC-PROG', 2, 0]] },
  { n: 13, lead: 7, ago: 1, status: 'pending_approval', note: 'School trust wants education pricing on the microphones. The 20-classroom order depends on it.',
    lines: [['EH-LS12000B', 1, 5], ['MXA920', 2, 9], ['TESIRAFORTE-AI', 1, 5], ['QA75Q60D', 20, 6], ['SVC-PROG', 10, 0]] },
];

const pad = (n: number) => String(n).padStart(2, '0');
// a moment `days` ago at roughly that hour in India, as the database's UTC text; never later than now
const utcAgo = (days: number, hourIST = 11) => {
  const t = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10) + ` ${pad(hourIST - 6)}:${pad((days * 7) % 60)}:00`;
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  return t > now ? now : t;
};
const dayIST = (offset: number) => new Date(Date.now() + 330 * 6e4 + offset * 864e5).toISOString().slice(0, 10);
const round2 = (n: number) => Math.round(n * 100) / 100;
const marks = (n: number) => Array(n).fill('?').join(',');

export async function demoStatus(db: D1Database) {
  return { loaded: (await db.prepare('SELECT COUNT(*) n FROM demo_rows').first<{ n: number }>())!.n > 0 };
}

export async function loadDemo(db: D1Database, admin: User) {
  if ((await demoStatus(db)).loaded) return { error: 'Sample data is already loaded. Remove it first.' };
  // shortcut: rows are claimed as "sample" by id range, so a real record saved during the same second would be claimed too; run this when nobody else is working.
  const before = await db.prepare('SELECT ' + TABLES.map((t) => `(SELECT COALESCE(MAX(id),0) FROM ${t}) ${t}`).join(', ')).first<Record<string, number>>();
  const password = [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 10) + '-Vt';
  const { salt, hash } = await hashPassword(password); // one hash shared by the four sample accounts
  const uid = (i: number) => `(SELECT id FROM users WHERE email = '${repEmail(i)}')`;
  const lid = `(SELECT MAX(id) FROM leads WHERE company = ?)`;
  const price = new Map(PRODUCTS.map((p) => [p[0], p]));

  const stmts: D1PreparedStatement[] = [
    ...REPS.map(([name, cap], i) => db.prepare(`INSERT OR IGNORE INTO users (email, name, role, pw_salt, pw_hash, max_discount_pct) VALUES (?,?,'member',?,?,?)`).bind(repEmail(i), name, salt, hash, cap)),
    // sample accounts left behind (switched off) by an earlier removal are brought back
    db.prepare(`UPDATE users SET active = 1, pw_salt = ?, pw_hash = ? WHERE email LIKE ?`).bind(salt, hash, '%' + DEMO_DOMAIN),
    ...PRODUCTS.map(([sku, name, brand, unit, cap]) => db.prepare('INSERT OR IGNORE INTO products (sku, name, brand, unit_price, max_discount_pct) VALUES (?,?,?,?,?)').bind(sku, name, brand, unit, cap)),
  ];
  for (const [sku, , , unit, cap] of PRODUCTS) {
    const change = PRICE_CHANGES.find((c) => c[0] === sku);
    const add = (old: number | null, now: number, days: number) => stmts.push(db.prepare(
      `INSERT INTO price_history (product_id, user_id, old_price, new_price, old_cap, new_cap, at) SELECT id, ?, ?, ?, ?, ?, ? FROM products WHERE sku = ? AND id > ?`)
      .bind(admin.id, old, now, old === null ? null : cap, cap, utcAgo(days, 16), sku, before!.products));
    add(null, change ? change[1] : unit, 60);
    if (change) add(change[1], unit, change[2]);
  }
  for (const l of LEADS) {
    const n = LEADS.indexOf(l) + 1;
    stmts.push(db.prepare(`INSERT INTO leads (owner_id, company, contact, phone, email, city, source, stage, est_value, next_followup, requirements, created_at, updated_at)
      VALUES (${uid(l.rep)},?,?,?,?,?,?,?,?,?,?,?,?)`).bind(l.company, l.contact, `+91 90000 000${pad(n)}`, `contact${n}@example.com`, l.city, l.source, l.stage, l.value,
      l.follow === null ? null : dayIST(l.follow), l.needs, utcAgo(l.created, 10), utcAgo(l.log.at(-1)![0])));
    for (const [days, kind, note] of l.log) stmts.push(db.prepare(`INSERT INTO interactions (lead_id, user_id, kind, note, at) VALUES (${lid}, ${uid(l.rep)}, ?, ?, ?)`).bind(l.company, kind, note, utcAgo(days, 9 + (days % 8))));
  }
  for (const b of BOQS) {
    const l = LEADS[b.lead], ref = `VT-BOQ-${dayIST(-b.ago).replace(/-/g, '')}-S${pad(b.n)}`;
    const lines = b.lines.map(([sku, qty, disc]) => { const p = price.get(sku)!, ch = PRICE_CHANGES.find((c) => c[0] === sku);
      const unit = ch && b.ago > ch[2] ? ch[1] : p[3]; // quoted before the price changed, so it carries the old price
      return { sku, qty, disc, unit, cap: Math.min(p[4], REPS[l.rep][1]), total: round2(qty * unit * (1 - disc / 100)), desc: `${sku} — ${p[1]}` }; });
    stmts.push(db.prepare(`INSERT INTO boqs (lead_id, user_id, ref, status, issued_on, total, note, decided_by, decided_at, decision_note, created_at) VALUES (${lid}, ${uid(l.rep)}, ?,?,?,?,?,?,?,?,?)`)
      .bind(l.company, ref, b.status, dayIST(-b.ago), round2(lines.reduce((s, x) => s + x.total, 0)), b.note ?? null, b.decision ? admin.id : null, b.decision ? utcAgo(b.ago, 17) : null, b.decision ?? null, utcAgo(b.ago, 15)));
    for (const x of lines) stmts.push(db.prepare(`INSERT INTO boq_lines (boq_id, product_id, description, qty, unit_price, discount_pct, line_total, cap_pct)
      VALUES ((SELECT id FROM boqs WHERE ref = ?), (SELECT id FROM products WHERE sku = ?), ?,?,?,?,?,?)`).bind(ref, x.sku, x.desc, x.qty, x.unit, x.disc, x.total, x.cap));
  }
  stmts.push(db.prepare(`INSERT OR IGNORE INTO demo_rows SELECT 'users', id FROM users WHERE email LIKE ?`).bind('%' + DEMO_DOMAIN));
  stmts.push(...TABLES.map((t) => db.prepare(`INSERT OR IGNORE INTO demo_rows SELECT '${t}', id FROM ${t} WHERE id > ?`).bind(before![t])));
  for (let i = 0; i < stmts.length; i += 90) await db.batch(stmts.slice(i, i + 90));
  return { ok: true, password, logins: REPS.map((_, i) => repEmail(i)), leads: LEADS.length, products: PRODUCTS.length, boqs: BOQS.length };
}

// Removes only what loadDemo created, plus anything later attached to those sample leads and accounts.
export async function clearDemo(db: D1Database) {
  const ids = (t: string) => `(SELECT id FROM demo_rows WHERE tbl = '${t}')`;
  const leads = `(SELECT id FROM leads WHERE id IN ${ids('leads')} OR owner_id IN ${ids('users')})`;
  await db.batch([
    `DELETE FROM boq_lines WHERE boq_id IN (SELECT id FROM boqs WHERE lead_id IN ${leads})`,
    `DELETE FROM boqs WHERE lead_id IN ${leads}`,
    `DELETE FROM interactions WHERE lead_id IN ${leads}`,
    `DELETE FROM leads WHERE id IN ${leads}`,
    `DELETE FROM sessions WHERE user_id IN ${ids('users')}`,
    // a sample product or account that real records now point at is switched off instead of deleted
    `UPDATE products SET active = 0 WHERE id IN ${ids('products')}`,
    `DELETE FROM price_history WHERE product_id IN ${ids('products')} AND product_id NOT IN (SELECT product_id FROM boq_lines WHERE product_id IS NOT NULL)`,
    `DELETE FROM products WHERE id IN ${ids('products')} AND id NOT IN (SELECT product_id FROM boq_lines WHERE product_id IS NOT NULL)`,
    `UPDATE users SET active = 0 WHERE id IN ${ids('users')}`,
    `DELETE FROM users WHERE id IN ${ids('users')} AND id NOT IN (SELECT user_id FROM interactions) AND id NOT IN (SELECT user_id FROM boqs) AND id NOT IN (SELECT owner_id FROM leads)
       AND id NOT IN (SELECT user_id FROM price_history WHERE user_id IS NOT NULL)`,
    `DELETE FROM demo_rows`,
  ].map((s) => db.prepare(s)));
  return { ok: true };
}
