# VTech Sales Tracker — sales.vtech.services

Lead tracking for VTech Technologies' sales team.

- **Leads** per salesperson (reps see only their own; admins see all and can reassign), stages from new → won/lost, estimated value, next follow-up date.
- **Interactions** log (call, meeting, site visit, email, WhatsApp, note) that also sets the next follow-up and stage.
- **BOQs issued** per lead, priced from the central **price list**. Each product has a max discount %; reps cannot exceed it, admins can. Issuing a BOQ moves the lead to "BOQ sent".
- **Reminders**: every day at 08:30 IST each salesperson is emailed their overdue + today's follow-ups.
- **Stack**: one Cloudflare Worker (`src/index.ts`) + D1 + static `public/index.html`. Push to `main` deploys via Workers Builds.

## Setup (once)
1. Open https://sales.vtech.services and create the admin account with `ADMIN_EMAIL` (set in `wrangler.jsonc`).
2. Add products under Price list, then add salespeople under Users.
3. Each salesperson's email must be verified once in Cloudflare → Email Routing → Destination addresses to receive reminders.

## Local dev
`npm i && npx wrangler dev` — uses a local D1; tables are created on first request.
