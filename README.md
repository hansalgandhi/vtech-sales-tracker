# VTech Sales Tracker — sales.vtech.services

Lead tracking for VTech Technologies' sales team.

- **Leads** per salesperson (reps see only their own; admins see all and can reassign): client requirements, stage from new → won/lost, estimated value, next follow-up date. The list shows each lead's last interaction, next follow-up, BOQs sent and the last BOQ's value, with filters for "follow-up due" and "no contact in 7+ days" and a CSV export.
- **Interactions** log (call, meeting, site visit, email, WhatsApp, note) that also sets the next follow-up and stage.
- **BOQs** per lead, priced only from the central **price list**; a printable page per BOQ, a register of every BOQ, and "Revise" to start a new one from an old one. The lead shows the price last sent for each item.
- **Price list**: admin-only edits, CSV import, and a log of every price or discount-limit change.
- **Discounts**: each product has a max discount and each salesperson has their own limit. A BOQ above the lower of the two is held as "awaiting approval", admins are emailed, and it only counts as sent once an admin approves it.
- **Reminders**: every day at 08:30 IST each salesperson is emailed their overdue + today's follow-ups.
- **Accounts**: users change their own password; admins reset passwords, set roles and limits. Sign-in locks for 15 minutes after 5 wrong passwords.
- **Stack**: one Cloudflare Worker (`src/index.ts`) + D1 + static `public/` (`index.html`, `app.js`, `_headers`). Push to `main` deploys via Workers Builds. New columns are added to the live database automatically on the first request after a deploy.

## Setup (once)
1. Open https://sales.vtech.services and create the admin account with `ADMIN_EMAIL` (set in `wrangler.jsonc`).
2. Add products under Price list, then add salespeople under Users.
3. Each salesperson's email must be verified once in Cloudflare → Email Routing → Destination addresses to receive reminders.

## Local dev
`npm i && npx wrangler dev` — uses a local D1; tables are created on first request.

## Sample data
Users → Sample data loads four sample salespeople, a 30-item price list, 18 leads with interaction history and 13 BOQs (two awaiting approval), dated relative to today. The sample accounts' password is generated at load and shown once. "Remove sample data" deletes only what was loaded, plus anything created on the sample leads or by the sample accounts. Prices are illustrative, not VTech's.

## Look and motion
Colours, logo and favicon follow VTech's own identity (the magenta-to-purple logo, taken from vtechpl.com). Animation is plain CSS and a few lines of JavaScript, using the spring settings published in Pin UI's motion tokens (pinui.xyz, MIT) sampled into CSS `linear()` curves. Nothing is loaded from outside the app.

## Tests
```
npx wrangler dev --port 8799 --var ADMIN_EMAIL:admin@test.local   # terminal 1
npm test                                                          # terminal 2
```
