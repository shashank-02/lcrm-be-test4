# Lead CRM — codebase skill for AI assistants

Paste this file (or point Claude at it) when you want help extending the system. It captures the conventions that keep the codebase consistent so new code lands in the right place with the right shape.

## 1. What this system is

A lead-management CRM for loan/finance calling teams. Two repos:

* `lead-crm-backend` — Node 20, Express 4, TypeScript (strict), Mongoose 8, zod, JWT auth. REST API under `/api/v1`.
* `lead-crm-frontend` — React 18 + Vite + TypeScript, Tailwind (CSS-variable theme), TanStack Query, zustand, react-router v6.

Domain vocabulary: **Organisation** (tenant) → **Teams** (manager + team lead) → **Users** (roles `admin | branch_manager | team_lead | agent`). **Leads** move through **Stages** (pipeline), carry a **Status** (call outcome), a **Source**, an **owner**, admin-defined **custom fields**, and have **Notes / Tasks / CallLogs / Files / Activities**. **PermissionTemplates** define what a role variant can do. **StageDirectives** enforce rules on stage entry. **AssignmentRules** auto-assign unowned leads. **ImportJobs** track CSV imports. **MessageTemplates** render deep links (WhatsApp/email/call).

## 2. Backend conventions

### Folder map
```
src/config      env (zod), logger (pino), db
src/common      errors.ts (AppError + helpers) · http.ts (ok/created/asyncHandler) · pagination.ts · dates.ts (org tz)
                mongoose.ts (toJSONPlugin, escapeRegex) · permissions.ts (CATALOGUE — single source of truth) · crud.ts (crudRouter factory)
src/middleware  auth.ts (requireAuth, requirePermission, requireRole, hasPermission) · validate.ts · errorHandler.ts
src/services    scope.service (visibility filters) · permission.service (resolve + buildAuthUser) · assignment.service
                storage.service (S3/local driver) · template.service · activity.service
src/models      one file per collection (+ Pipeline.ts, LeadSubEntities.ts group small ones); index.ts re-exports
src/modules     <context>/<name>.routes.ts (+ optional <name>.service.ts). Mounted in src/app.ts
src/scripts     seed.ts
tests/unit      pure logic, no DB · tests/integration  supertest + mongodb-memory-server · tests/helpers/db.ts (seedBasic, login, auth)
```

### Rules of the road
1. **Every model has `orgId`** (indexed) and every query includes `orgId: req.user.orgId` (directly or via `leadScope(user)`). Unique indexes are compound with `orgId`.
2. **Routes are thin.** Pattern:
   ```ts
   router.post('/:id/thing', requirePermission('lead.edit'), validate({ params: idParam, body: schema }), asyncHandler(async (req, res) => {
     const lead = await getLeadInScope(req.user!, req.params.id);   // 404 if outside visibility
     ...mutate...
     await logActivity({ orgId, leadId, userId: req.user!.id, type: 'updated', description: '...' });
     ok(res, result);   // { success: true, data } ; use created() for 201
   }));
   ```
3. **Validation is zod via `validate()`**, which replaces `req.body/query/params` with the parsed value. Never trust raw `req.body`.
4. **Errors are thrown**, never returned: `throw notFound('Lead')`, `throw forbidden()`, `throw conflict('msg', details)`, `throw validationError(issues)`, or `new AppError(422, 'CODE', msg, details)`. `errorHandler` maps them (and Mongo 11000 → 409 `DUPLICATE`).
5. **Permissions**: gate routes with `requirePermission('key')` (admin bypasses). Inside services use `hasPermission(user, key)`. To add a key: add it to `PERMISSION_CATALOGUE` in `common/permissions.ts`, add to the right `DEFAULT_ROLE_PERMISSIONS`, and (if seeded orgs exist) update their system templates. The frontend reads the catalogue from `/bootstrap`; `AppShell` nav + `useCan()` use the same keys.
6. **Visibility**: never hand-roll owner/team filters; use `leadScope(user)`, `visibleTeamIds(user)`, `assignableUsers(user)`, `canAssignTo(user, id)`, `ownershipFor(orgId, ownerId)`.
7. **Lists**: `paginationQuery` + `buildSort(q, ALLOWED_FIELDS)` + `buildMeta`. Sort fields must be whitelisted. Reads use `.lean()` and `normalise()` (`_id → id`); writes use documents so `toJSON()` applies.
8. **Write an Activity** for anything a manager would want on the timeline (`ACTIVITY_TYPES` in `models/Activity.ts` — extend the enum when adding a type).
9. **Dates**: "today" is computed in the org timezone with `todayRange(user.timezone)`. Store UTC.
10. **Config entities** (stage/status/source/directive/template/field/view/rule) use `crudRouter()` in `common/crud.ts`. New simple entity = new model + one `crudRouter({...})` block in `modules/config/config.routes.ts` (+ add to `/bootstrap` if the UI needs it).
11. **Files**: never proxy binaries through the API in production. Use `storage().presignUpload/presignDownload`; store only `storageKey` metadata.
12. **Tests**: unit for pure functions; integration for every new route family — copy the shape of `tests/integration/leads.test.ts` (uses `seedBasic()` + `login('agent1')`). Keep `npm run typecheck` clean; `noUnusedLocals` is on.

### How-to recipes

**Add a field to Lead (system field, not custom):** `models/Lead.ts` schema → `leadBody` zod in `leads.routes.ts` → `LEAD_SORTABLE` if sortable → `decorateLeads` if it needs a lookup → export CSV headers → frontend `types/index.ts` `Lead` + `SYSTEM_COLS` in `LeadsPage.tsx` + `SYSTEM_FIELDS` in `LeadDetailPage.tsx`. (Prefer a custom `FieldDefinition` — zero code.)

**Add a lead action (e.g. "mark as VIP"):** permission key → route `POST /leads/:id/vip` in `leads.routes.ts` (pattern in rule 2) → activity type → frontend button in `LeadDetailPage` header using `api.post` + `useLeadInvalidate()`; optional bulk variant in the `bulk` switch.

**Add a report:** new `GET /reports/<name>` in `modules/reports/reports.routes.ts` using `reportFilter(user, q)` for scope; aggregate; frontend tab in `pages/reports/ReportsPage.tsx`.

**Add a new module (e.g. quotations):** `models/Quotation.ts` (orgId, leadId, createdById…) → export in `models/index.ts` → `modules/quotations/quotations.routes.ts` → mount in `app.ts` after `requireAuth` → permissions `quote.view/create` → integration test → frontend `types` + tab component in `pages/leads/LeadDetailTabs.tsx` + add to `FIXED_TABS`.

**Swap deep links for a real WhatsApp/SMS provider:** implement a `MessageProvider` (send(to, body) → messageId) in `services/`, call it in `POST /leads/:id/communicate` when `channel==='whatsapp'` and a provider is configured, and keep returning `link` as a fallback. Templates already render via `renderTemplate()`.

**Second tenant:** run the seed with different `SEED_*` values (creates a new `Organisation` + admin). Everything else is already scoped.

## 3. Frontend conventions

* **Data fetching**: TanStack Query. Keys: `['leads', params]`, `['lead', id]`, `['lead-activities'|'lead-notes'|'lead-tasks'|'lead-calls'|'lead-files', id]`, `['lead-counts', filters]`, `['bootstrap']`, `['config', endpoint]`, `['users', params]`, `['teams']`, `['permission-templates']`, `['imports']`, `['dashboard']`. After a lead mutation call `useLeadInvalidate()(leadId)`; after admin config changes call `useInvalidateBootstrap()`.
* **API**: always through `api` from `lib/api.ts` (adds bearer, refreshes on 401 once). Errors → `toast.error(errorMessage(e))`; field-level errors → `errorDetails(e)` returns the zod issue array `{path, message}`.
* **Permissions**: `const can = useCan(); can('lead.assign')` — hide controls the user cannot use; the API still enforces.
* **Reference data**: `const { boot } = useBootstrap();` → `boot.stages/statuses/sources/fields/templates/users/teams/org/roles/permissionCatalogue`.
* **Custom fields**: render inputs with `<DynamicInput def value onChange />`, display with `fieldValue(def, value, currency)`. Fields group by `def.tab` → `def.section`.
* **Admin CRUD pages**: describe the entity in `pages/admin/configSpecs.tsx` (`columns`, `fields`, `defaults`, `toForm`, `toPayload`) and render `<ConfigCrudPage spec={...} />`.
* **UI kit**: `components/ui/index.tsx` — `Button, Input, Select, Textarea, Field, Checkbox, Toggle, Badge, Avatar, Modal, Confirm, Menu, Tabs, PageHeader, Pagination, PillSelect, Empty, Spinner`. Use `.card`, `.input`, `.th`, `.td`, `.pill`, `.menu-item` utility classes from `styles/globals.css`.
* **Theme**: colours are CSS variables (`--bg --surface --surface-2 --border --text --text-2 --text-3 --primary --primary-soft --navy --success --warning --danger --info`) exposed as Tailwind colours `bg surface surface-2 line ink ink-2 ink-3 primary primary-soft navy success warning danger info`. Do not hard-code hex except for status/stage colours coming from data. Dark mode = `.dark` on `<html>`.
* **Formatting**: `fmtDateTime` (YYYY-MM-DD hh:mm A), `fmtDate`, `fmtRelative`, `fmtCurrency` (en-IN), `orDash`. Empty values render `—`.
* **Routing**: pages are lazy-loaded in `App.tsx`; admin sub-pages in `pages/admin/AdminRoutes.tsx` (`NAV` array is permission-gated).
* **Files**: upload = `POST /leads/:id/files/presign` → `fetch(uploadUrl, {method:'PUT', headers, body})` → `POST /files/:id/confirm` (see `FilesTab`).

## 3b. Modules added in v1.1

| Module | Files | Notes |
|---|---|---|
| Auth hardening | `modules/auth`, `services/otp.service`, `services/mail.service`, `middleware/auth` | Login → optional OTP challenge (`requires2FA`) → `/auth/verify-otp`. Access tokens carry `sid`; `requireAuth` checks the `Session` row so logout is immediate. `requireClientKey`, `sanitizeInput`. |
| Notifications | `models/Notification`, `services/notification.service`, `services/scheduler.service`, `modules/notifications` | `notify()` with `dedupeKey`; scheduler `tick()` every minute (follow-ups due/overdue, tasks, note reminders, snooze wake-ups, top-ups). `notifyOwnerOfAdminAction()` for admin/manager actions on someone else's lead. |
| Top-up reminders | `models/TopUpReminder`, `services/topup.service`, `topupRouter` | `ensureTopUpReminder()` on entering a `isWon` stage or setting `custom.disbursedDate`; `cycleKey` prevents duplicates; `backfillTopUpReminders()` in seed. |
| Files Corner | `models/Documents`, `modules/documents`, `services/access.service` | `canSee()/audienceFilter()` implement role+team+user visibility. View = `view-token` → `/view?token=` streamed inline (pre-auth mount in `app.ts`); download requires `files.download`. |
| Training | `models/Training`, `modules/training` | Same audience model; range streaming for local uploads, presigned redirect on S3; progress upsert per user. |
| Project admin | `modules/admin`, `models/ProjectConfig`, `organisation.routes` | Audit log, view groups, prioritisation rules (`services/prioritization.service`), FB events (`services/fb.service`, token encrypted). Lead columns/column groups/stage-bar toggle live in `Organisation.settings`. |
| Profiles | `modules/profile`, `services/crypto.service` | `/me/profile`, avatar upload → `/public/avatar/:key`; bank/PAN fields encrypted with `FIELD_ENCRYPTION_KEY`. |
| Audit | `services/audit.service` | `audit(user, {...})` fire-and-forget; call it from any admin mutation. |

Frontend: `components/NotificationCenter.tsx` (bell, panel, persistent pop-ups), `store/context.ts` (team/member switcher), `pages/leads/QuickAccess.tsx` (call-log drawer, quick note, top-up outcome, WA/email), `pages/FilesPage.tsx`, `pages/TrainingPage.tsx`, `pages/ProfilePage.tsx`, `pages/admin/ProjectAdminRoutes.tsx` + `projectPages.tsx`, `components/AudiencePicker.tsx`. `api.ts` sends `X-Requested-With` and optional `X-Client-Key`; `apiUrl()` builds URLs for signed streams.

Permission keys added: `lead.view_team`, `lead.edit_subordinates`, `context.view`, `context.switch`, `notification.view`, `topup.view`, `topup.action`, `files.view|download|manage`, `training.view|manage|view_progress`, `admin.project`, `admin.audit`, `admin.profiles`. Agents no longer have `note.edit`/`note.delete` by default (`PERMISSION_MIGRATIONS` applies this to existing system templates on seed).

## 3c. Modules added in v1.2

| Module | Files | Notes |
|---|---|---|
| Session tracking | `models/Session`, `services/session.service`, `middleware/auth`, `modules/auth` | `endSessions(filter, reason)`, `touchSession(sid)` heartbeat, `sweepStaleSessions()` (scheduler), `isOnline()`. Never fabricate logout times. |
| Login & Logout report | `modules/reports/sessions.report.ts` | `/reports/login-sessions` (+`/export`, `/online`); `toRow()`/`summarize()` are pure and unit-tested. Joins users in JS (no `$lookup`). |
| UI config | `common/uiconfig.ts`, `organisation.routes`, `bootstrap.routes` | Catalogue + `normalizeLayout()`. Frontend mirror: `src/lib/uiconfig.ts` — keep keys in sync. Editors: `pages/admin/layoutPages.tsx` + `components/LayoutEditor.tsx`. |
| Mail | `services/mail.service` (`mailDriver`, `sender`, `mailStatus` (masked), `verifyMailTransport`, templates `otpEmail`/`testEmail`/`credentialsEmail`), `organisation.routes` (`/mail-status?verify=`, `/mail-test`), `users.routes` (`sendCredentials`) | Env: `MAIL_DRIVER=smtp`, `SMTP_*`, `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME`, `APP_URL`. OTP sends before storing the challenge; production refuses when unconfigured; message bodies/codes are never logged in production. |
| Index migrations | `config/indexes.ts` (`migrateIndexes`, run by `connectDb`) | Drops the legacy leads `$text` index (its `language_override` collided with `lead.language`). Add future one-off index fixes here. |
| File viewer (frontend) | `components/viewer/{FileViewer,engines,useFileBlob}.tsx` | Lazy engines: pdf.js, docx-preview, SheetJS, OOXML PPTX renderer, images, text. Fetches the signed `/view?token=` stream as a Blob. |
| Unified Administration (frontend) | `pages/admin/AdminRoutes.tsx` | Grouped nav, `?tab=` sub-tabs, `PROJECT_ADMIN_REDIRECTS` for old URLs. There is no separate Project Administration section. |

Frontend conventions introduced in v1.2: `cn()` uses tailwind-merge (later classes win); theme colours are RGB-channel tokens so `/alpha` modifiers work; `PageHeader` renders a `BackButton` on all non-root pages; `Menu` clamps to the viewport (`mobileSheet` for wide panels); the app shell is `h-[100dvh] overflow-hidden` with `<main id="main-scroll">` as the only scroller — never put `overflow-x: hidden` on `body`.

## 4. API surface (summary)

```
POST /auth/login {identifier,password} · POST /auth/refresh · POST /auth/logout · GET /auth/me · POST /auth/change-password · GET /auth/permission-catalogue
GET  /bootstrap
GET|PATCH /organisation
GET  /users/assignable · GET|POST /users · GET|PATCH /users/:id · POST /users/:id/deactivate {reassignTo?,force?} · POST /users/:id/activate
GET|POST /teams · GET|PATCH|DELETE /teams/:id · POST /teams/:id/members {userIds} · DELETE /teams/:id/members/:userId
GET|POST /permission-templates · PATCH|DELETE /permission-templates/:id · POST /permission-templates/:id/clone
/config/{stages,statuses,sources,stage-directives,templates,fields,views,assignment-rules}: GET, GET/:id, POST, PATCH/:id, DELETE/:id, POST/reorder {ids}
GET  /leads?tab=&search=&ownerId=&stageId=&statusId=&sourceId=&teamId=&from=&to=&custom.<key>=&page=&limit=&sortBy=&sortDir=
GET  /leads/counts · GET /leads/export (CSV) · GET /leads/check-phone?phone=
POST /leads · POST /leads/bulk {ids,action,payload}
GET|PATCH|DELETE /leads/:id · POST /leads/:id/{stage,status,assign,followup,communicate,restore} · GET /leads/:id/activities
/leads/:leadId/{notes,tasks,calls}: GET, POST, PATCH/:id, DELETE/:id
GET  /leads/:leadId/files · POST /leads/:leadId/files/presign · POST /files/:id/confirm · GET /files/:id/download · PATCH|DELETE /files/:id
GET  /imports/targets · POST /imports/preview (multipart) · POST /imports (multipart) · GET /imports · GET /imports/:id · GET /imports/:id/errors.csv · GET /imports/:id/file
GET  /reports/{dashboard,trend,performance,teams,activity-feed,imports}?from=&to=&teamId=&userId=
POST /auth/verify-otp {challengeId,code} · POST /auth/resend-otp
GET  /public/branding · GET /public/branding/logo · GET /public/avatar/:key
GET|PATCH /me/profile · POST|DELETE /me/profile/avatar · GET|PATCH /users/:id/profile
POST|DELETE /organisation/logo
GET  /notifications?filter= · GET /notifications/unread-count · POST /notifications/read-all · POST /notifications/:id/{read,complete,dismiss,snooze}
GET  /topup-reminders?status=&ownerId= · POST /topup-reminders/:id/{complete,snooze,dismiss} · POST /topup-reminders/backfill
GET|POST /documents/folders · PATCH|DELETE /documents/folders/:id · GET|POST /documents · PATCH|DELETE /documents/:id · POST /documents/:id/replace · GET /documents/:id/view-token · GET /documents/:id/view?token= · GET /documents/:id/download
/training/categories (crud) · GET|POST /training · GET /training/overview · GET|PATCH|DELETE /training/:id · GET /training/:id/view?token= · GET|POST /training/:id/progress
GET  /reports/login-sessions?from=&to=&teamId=&userId=&status=&sortBy=&sortDir=&page=&limit= · GET /reports/login-sessions/export · GET /reports/login-sessions/online
GET  /organisation/mail-status · POST /organisation/mail-test {to?}
PATCH /organisation { settings: { leadTabs, dashboards: {role: [...]}, quickActions } }
GET  /audit-logs · /config/view-groups (crud) · /config/prioritization (crud) + POST /recompute · /config/fb-events (crud)
GET  /health
```
Responses: `{ success: true, data, meta? }` or `{ success: false, error: { code, message, details? } }`.

## 5. Things that are intentionally simple (and where to grow them)

| Today | Grow into |
|---|---|
| Imports run in-process (`setImmediate`) | SQS + worker consuming `ImportJob` |
| Deep-link comms | Provider adapter (WhatsApp Business API / Twilio / SES) |
| Refresh token in response body (localStorage) | httpOnly cookie with `SameSite=None; Secure` if UI and API share a parent domain |
| Single org via seed | Subdomain → `orgId` resolution at login; org admin self-signup |
| Quality score heuristic in `computeQualityScore` | ML scoring service writing `qualityScore` |
| Console rate limits | WAF / API Gateway in front of App Runner |
