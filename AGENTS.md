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

## MCP for cloud agents (efficient use)

Use MCP to reduce guesswork and avoid stale training data. Prefer **this repo’s specs and code** first; call MCP when you need **external API semantics** or **design validation**.

### Context7 — library and framework docs

- **When**: Implementing or debugging against an npm/SDK API (e.g. `payjp`, `@discordjs/rest`, Vitest, Playwright); verifying parameter names, error shapes, or migration notes.
- **How**: Resolve the library ID first, then ask a **narrow** question (concrete API surface or error). Avoid broad “explain everything” queries; cap follow-up queries to what the task needs.
- **When not**: Behavior already fixed in `2weeks-spec.md` / `implementation-design-mvp.md` — follow the repo, not generic docs.

### Serena — planning and structural edits

- **When**: Choosing between approaches, before a large refactor, or when you want a quick sanity pass on a plan (use `sanity_check` early, not only at the end).
- **When not**: Trivial one-file edits where reading local code is enough.

### DeepWiki — external repo / wiki-style summaries

- **When**: You need a **high-level map** of a third-party repository or ecosystem page (architecture, main modules, how pieces connect) and repo-local search is insufficient.
- **How**: Pass a specific `owner/repo` or URL; prefer **shallow** depth unless you need multiple linked pages. Distill into actions in *this* codebase; do not treat DeepWiki as authoritative over pinned versions in `package.json`.

### Suggested order

1. Specs + grep/read in this repo.  
2. **Serena** `sanity_check` if the approach is non-obvious or high-risk.  
3. **Context7** for exact SDK/API usage.  
4. **DeepWiki** only if you still lack a mental model of an external project.  
5. **Playwright** (or local scripts) for browser/E2E verification when the change is user-visible.

## When unsure

1. Re-read the three spec files above.  
2. Match existing patterns in the nearest package.  
3. Prefer minimal diffs and preserve behavior unless the spec says otherwise.
