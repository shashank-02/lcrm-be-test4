# Lead CRM — Backend API

REST API for a lead-management CRM built for loan and finance calling teams. Node 20 · Express · TypeScript · MongoDB · S3.

**Docs:** [Architecture & diagrams](docs/ARCHITECTURE.md) · [AWS deployment (beginner guide)](docs/DEPLOYMENT.md) · [Codebase skill for AI assistants](docs/CLAUDE_SKILL.md)

## Features

- **Auth & accounts** — login by email / username / phone; JWT access + rotating refresh tokens with server-side revocation; forced password change; account deactivation with lead hand-over.
- **Roles & permissions** — Admin, Branch Manager, Team Lead, Calling Agent. 52 granular permissions grouped into admin-editable **permission templates** (per-role defaults + custom variants). Admin can always do everything.
- **Data visibility** — derived from the team hierarchy: agents see their leads, team leads their team, managers their teams, admins everything.
- **Leads** — list tabs (Contacted / Assigned / Created / Follow-ups today, Overdue, Unassigned, Today list, All), filters incl. custom-field filters, sortable columns, CSV export, duplicate-phone detection, soft delete + restore, quality score.
- **Pipeline** — configurable stages (won/lost flags), statuses (optionally per stage), sources, and **stage directives** (mandatory fields / remark / follow-up / allowed roles when entering a stage).
- **Custom fields** — admin-defined fields grouped into tabs & sections (seeded with loan, credit-card, disbursement and product fields); validated server-side.
- **Assignment** — manual, bulk (with *erase history*), and rules (round-robin, least-loaded, specific user) applied on create and import.
- **Activity** — immutable timeline + audit trail, notes, tasks, call logs (outcome updates lead status), documents via presigned S3 upload (local-disk driver for dev).
- **Communication** — message templates with `{{placeholders}}` rendered into WhatsApp / mailto / tel deep links; every touch logged. Adapter seam for real providers.
- **Bulk import** — CSV preview → column mapping → async job with per-row error report (downloadable), create or upsert mode, auto-created sources, assignment rules.
- **Reports** — dashboard KPIs + funnel, daily trend, per-agent performance, team comparison, activity feed.
- **Notifications** — persistent per-user notification centre (follow-up due/overdue, tasks, note reminders, assignments, admin actions on your leads, top-up reminders) with priorities, snooze/complete/dismiss and an in-process scheduler; nothing disappears until actioned.
- **3-month top-up reminders** — automatic per-lead timer from the disbursement date, reassignment-aware, outcome recording, admin report; backfill for already-disbursed leads.
- **Files Corner** — admin-managed folders and documents with role + team + user visibility, view-only streaming for non-admins (download blocked at the API), replace/rename/audit.
- **Training Hub** — videos (upload with range streaming or YouTube/Vimeo/links), documents, tutorials and external links with categories, visibility, search, completion & progress tracking.
- **Project Administration** — lead layout (fields/sections), list columns & column groups, view tabs & groups, prioritisation rules, FB Conversions API mappings, feature permissions (incl. Show Lead Status Bar), audit log.
- **Profiles** — profile page with photo upload, employee/bank details (encrypted at rest), account & team information.
- **Security** — email OTP 2FA (per user, SMTP), bcrypt(12) passwords never returned by any endpoint, session-bound access tokens (logout invalidates immediately), account lockout, NoSQL-injection sanitiser, optional client key header, helmet/HSTS, signed short-lived tokens for file streaming, field-level AES-256-GCM encryption, append-only audit log.
- **Login & Logout report** — every sign-in is a `Session` row with login time, last activity, honest end time/reason (logout, expired, revoked); Reports → Login & Logout with filters, sorting, pagination, CSV.
- **Admin-configurable UI** — lead-page info tabs, per-role dashboard widgets and lead-page quick actions are stored on `Organisation.settings` and normalised against a server-side catalogue (`src/common/uiconfig.ts`).
- **Email diagnostics** — `/organisation/mail-status` and `/organisation/mail-test` so admins can verify SMTP from the UI; OTP sending fails loudly in production when mail is not configured.
- **Ops** — `/health`, structured logs (pino) with request IDs, rate limiting, helmet, graceful shutdown, multi-stage Dockerfile, GitHub Actions CI.

## Quick start

```bash
cp .env.example .env            # set MONGODB_URI, JWT secrets
npm install
npm run seed -- --demo          # org + admin + pipeline + fields + demo teams/users/60 leads
npm run dev                     # http://localhost:4000
```

Default login (from `.env`): `admin@example.com` / `Admin@12345`. Demo users share the password `Demo@12345` (`meera.manager`, `ravi.tl`, `anita.agent`, `karan.agent`, `priya.agent` — use the `@demo.local` email or the username).

Requires MongoDB locally (`docker run -d -p 27017:27017 mongo:7`).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start with hot reload (tsx) |
| `npm run typecheck` | `tsc --noEmit` (strict, no unused locals) |
| `npm test` | Unit + integration tests (Jest + Supertest + mongodb-memory-server) |
| `npm run test:unit` | Pure-logic tests only (no database) |
| `npm run seed [-- --demo]` | Idempotent seed; `--demo` adds sample data |
| `npm run build && npm start` | Compile to `dist/` and run |
| `docker build -t lead-crm-backend .` | Production image (non-root, healthcheck) |

## Environment

See [`.env.example`](.env.example). Key settings: `MONGODB_URI`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `CORS_ORIGINS`, `PUBLIC_API_URL`, `STORAGE_DRIVER` (`local` | `s3`), `S3_BUCKET`, `AWS_REGION`, `SEED_*`.

## Testing

```bash
npm run test:unit      # fast, no DB
npm test               # full suite; first run downloads a MongoDB binary (~100 MB) for the in-memory server
```

Tests default to an in-memory MongoDB. To run them against any Mongo-compatible server instead (a local `mongod`, Atlas, or FerretDB in sandboxes that cannot download the Mongo binary): `MONGO_TEST_URI=mongodb://127.0.0.1:27017 npm test` (add `MONGO_TEST_FLAVOUR=ferret` to skip the few `$lookup`/`$facet` report tests FerretDB cannot run).

Integration suites cover: authentication & token rotation, 2FA OTP flow, login/logout session tracking and the Login & Logout report, admin-configurable layouts (tabs, dashboards, quick actions), mail diagnostics, account lockout, server-side logout, role-based visibility and permission templates, team-hierarchy permissions (`lead.view_team`, `lead.edit_subordinates`), notes edit/delete permissions, the stage-bar setting, Files Corner visibility/download enforcement, lead lifecycle (create, custom-field validation, stage directives, status, follow-up permissions, bulk assign with erase history, delete/restore, export, assignment rules, deep-link communication), top-up reminders + notification scheduler, and CSV import (preview, create/upsert, error CSV).

## Project layout

```
src/
  config/       env · logger · db
  common/       errors · http · pagination · dates · permissions catalogue · crudRouter
  middleware/   auth · validate · errorHandler
  services/     scope · permission · assignment · storage · template · activity
  models/       Mongoose schemas (all org-scoped)
  modules/      auth · users · config · leads · files · imports · reports · bootstrap
  scripts/      seed.ts
tests/          unit/ · integration/ · helpers/
docs/           ARCHITECTURE.md · DEPLOYMENT.md · CLAUDE_SKILL.md
```

## API overview

Base URL `/api/v1`, JSON, bearer auth. Full route list in [docs/CLAUDE_SKILL.md §4](docs/CLAUDE_SKILL.md). Responses are `{ success, data, meta? }` or `{ success: false, error: { code, message, details? } }`.

## License

Private — © your company.
