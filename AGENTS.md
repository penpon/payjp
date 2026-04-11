# Agent instructions

This file orients automated coding agents working in this repository. Human-oriented detail lives in `CLAUDE.md` (Japanese) and `.claude/rules/`.

## Product and specs

- **Product**: PAY.JP × Discord subscription linking (OAuth, billing, role sync).
- **Spec source of truth** (keep in sync on any spec change):
  1. `2weeks-spec.md` — functional spec and Go-Live criteria
  2. `implementation-design-mvp.md` — API contracts, DB model, sequences
  3. `tdd-acceptance-matrix-mvp.md` — acceptance tests T-P0-01 … T-P0-07  
  Record spec changes as a Change Request in `2weeks-spec.md` and update all three. Do not expand MVP scope (no admin UI, DLQ, heavy observability, etc.) unless the human team explicitly changes the spec set.

## Stack and layout

- **Language**: TypeScript everywhere (services, CLI, frontend).
- **Runtime**: Node.js; **repo**: npm workspaces (`packages/*`, `frontend`).
- **DB**: PostgreSQL.
- **Integrations**: Discord via `@discordjs/rest` (REST only; no always-on bot). PAY.JP via `payjp`.
- **Lint/format**: Biome (pre-commit / `auto-format.sh` may run).

```
packages/
  shared/          types, DB schema, shared utils
  auth-service/    Discord OAuth (R1)
  billing-service/   PAY.JP (R2–R5)
  sync-service/    webhooks, role sync, manual CLI (R6–R8)
frontend/          subscription UI
feature/            git worktrees — do not delete
.vcsdd/             VCSDD pipeline state — do not delete
```

## Commands (from repo root)

| Command | Purpose |
| --- | --- |
| `npm test` | Vitest, all workspaces |
| `npm run test:auth` / `test:billing` / `test:sync` / `test:frontend` | Scoped Vitest |
| `npm run lint` | Biome check |
| `npm run format` | Biome write |
| `npm run e2e` | Playwright |
| `npm run docker:up` / `docker:down` | Compose via `scripts/docker-compose-op.sh` |

Prefer the smallest command that validates your change (scoped tests before full suite when practical).

## Git and delivery

- **Branching**: Do not commit directly on `main` for feature work; use a dedicated branch (human workflow often uses `feat/issue-N-…`; cloud agents may use `cursor/…` per team policy).
- **Commits**: Small, descriptive messages; include `Fixes #N` when closing a tracked issue.
- **PRs**: Run lint/tests relevant to the diff before requesting review.

## Workflows (when to use what)

- **Business logic** in the three services: follow the VCSDD pipeline when changing pure core/shell (see `CLAUDE.md` for phase order and `/vcsdd-*` commands in Claude Code).
- **Integration layer** (HTTP servers, DB wiring, frontend, E2E, deploy): issue-driven + TDD; see `.claude/rules/workflow.md` for review steps and optional slash commands (`/issue-start`, `/code-review`, etc.).

## Security and secrets (non-negotiable)

Full rules: `.claude/rules/security.md`. In short:

- **PAY.JP**: Require 3DS `verified`; persist `operationId` before PAY.JP writes; on ambiguous failure return **503** with `operationId`; do not auto-clear `inflight_operation_*` except via documented manual CLI.
- **Cookies**: `__Host-` prefix cookies keep fixed attributes (Secure, `Path=/`, HttpOnly, `SameSite=Lax`); do not weaken.
- **Secrets**: Do **not** read `.env*` or dump environment (`Read`/`cat`/`grep` on env files, `printenv`, `docker exec … env`, etc.). Do not add files that embed secrets. Use `op read` / `op run` patterns documented for this repo when keys are required.

## Tooling hints (optional MCP)

- Library docs: Context7 (or project docs) for PAY.JP, Discord API, Node.
- Deep refactors / symbol-aware edits: Serena (if available).
- Browser E2E: Playwright.

## When unsure

1. Re-read the three spec files above.  
2. Match existing patterns in the nearest package.  
3. Prefer minimal diffs and preserve behavior unless the spec says otherwise.
