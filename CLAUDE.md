# CLAUDE.md — lead-crm-backend

Read `docs/CLAUDE_SKILL.md` first; it holds the conventions. Quick facts:

- Stack: Node 20 · Express 4 · TypeScript strict · Mongoose 8 · zod · JWT. API base `/api/v1`.
- Commands: `npm run dev` (tsx watch) · `npm run typecheck` · `npm test` (unit + integration, needs mongodb-memory-server download) · `npm run test:unit` · `npm run seed [-- --demo]` · `npm run build && npm start`.
- Every collection has `orgId`; every query is org-scoped. Visibility comes from `services/scope.service.ts`, permissions from `common/permissions.ts` + `middleware/auth.ts`.
- Routes: thin, zod-validated, `asyncHandler`, throw `AppError` helpers, respond with `ok()/created()`, log an `Activity` for anything user-visible.
- Keep `npm run typecheck` clean (`noUnusedLocals` is on) and add an integration test for new route families.
