# PAY.JP × Discord Integration Service — Claude Configuration

## Behavioral Guidelines

Behavioral guidelines to reduce common LLM coding mistakes.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

## Spec Document Hierarchy (Authoritative)

1. `2weeks-spec.md` — Functional spec (Go-Live source of truth)
2. `implementation-design-mvp.md` — Implementation design (API contracts, DB models, sequences — fixed)
3. `tdd-acceptance-matrix-mvp.md` — TDD acceptance criteria (T-P0-01 through T-P0-07)

**Rule:** Spec changes MUST be recorded as Change Requests against `2weeks-spec.md`, and all 3 documents kept in sync. Do NOT add MVP out-of-scope items (admin UI, DLQ, advanced monitoring, etc.).

## Tech Stack (Project-Specific Rules)

- Language: TypeScript
- Discord: `@discordjs/rest` (REST API only — no persistent bot)
- PAY.JP: `payjp` npm package
- Formatter/Linter: Biome (auto-applied via `auto-format.sh`)

## Directory Structure

```
packages/
  shared/          # Type definitions, DB schema, shared utilities
  auth-service/    # Discord OAuth (R1)
  billing-service/ # PAY.JP billing (R2-R5)
  sync-service/    # Webhook + role sync + manual CLI tools (R6-R8)
frontend/          # Subscription UI
feature/           # git worktree directory (DO NOT delete)
.vcsdd/            # VCSDD pipeline state (DO NOT delete)
```

## Development Workflow

### Business Logic Layer (Complete) — VCSDD

For any business-logic addition or change, use the VCSDD pipeline.

- Phase order: `/vcsdd-spec` → `/vcsdd-spec-review` → `/vcsdd-tdd` → `/vcsdd-impl` → `/vcsdd-adversary` → `/vcsdd-harden` → `/vcsdd-converge`
- Commit: `/vcsdd-commit` (on phase completion)

### Integration Layer (In Progress) — Issue-Driven + TDD

HTTP servers, DB connections, frontend, E2E, and deployment are developed per GitHub Issue.

- Milestone: `MVP Go-Live` (2026-04-20)
- Issues: #1 through #10 (dependencies documented in each Issue body)
- Start an Issue with `/issue-start <number>`

References:
- `.claude/rules/workflow.md` — Detailed procedures, tool selection matrix, per-Issue model recommendations
- `.claude/rules/e2e.md` — E2E (Playwright) authoring rules and spec alignment

## Tool Selection

- Semantic code operations: mcp-serena (symbol search & edit)
- Library documentation: mcp-context7 (PAY.JP, Discord API, Node.js, etc.)
- GitHub operations: mcp-github (PR create, merge, status)
- Browser: mcp-playwright

## Custom Commands

| Command | Purpose |
|---|---|
| `/issue-start <number>` | Issue setup (create branch → load spec → plan) |
| `/daily-check` | Daily project health check |
| `/debug` | Debug workflow: reproduce → root cause → fix → verify |
| `/session-end` | Update memory and save state at session end |

## Quality Gates (REQUIRED)

- VCSDD scope (on business-logic changes): `/vcsdd-adversary` MUST PASS
- Issue scope (integration layer): `/code-review` → `/pr-review-toolkit:review-pr` → `pr-review-toolkit:code-simplifier` (3 steps REQUIRED; `security-guidance` is hook-driven and runs automatically)
- Go-Live decision: T-P0-01 through T-P0-07 — ALL must PASS

## Security & Implementation (FIXED Rules)

See `.claude/rules/security.md` for full details. Key rules:

- 3DS `verified` is REQUIRED. Write to PAY.JP only AFTER `operationId` is persisted. Indeterminate failures MUST return `503 + operationId` (no client auto-retry).
- `__Host-` Cookie §6 fixed attributes — DO NOT change (Secure, Path=/, HttpOnly, SameSite=Lax).
- READING `.env*` files is FORBIDDEN. Fetch secrets per-item via `op read`.
