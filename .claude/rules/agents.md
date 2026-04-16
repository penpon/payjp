# Specialized Agents & Skills — Scenario Map

For non-trivial work, prefer specialized agents/skills over generic ones.
Invoke via:
- **Agent tool** (`subagent_type: "<plugin>:<agent>"`) for `voltagent-*`, `pr-review-toolkit:*`, `vcsdd-*`
- **Skill tool** (`skill: "<plugin>:<skill>"`) for `superpowers:*`, `chrome-devtools-mcp:*`
- **Slash commands** (`/command`) for `/code-review`, `/feature-dev`, `/vcsdd-*`, etc.

## Subagent Model Selection (Token Optimization)

Keep Opus for the main thread. Downgrade subagents by task type.

| Task | model param | Rationale |
|---|---|---|
| Explore / Grep / Glob / file search | `model: "haiku"` | Read-only, Opus unnecessary |
| Code review / static analysis | `model: "sonnet"` | Needs judgment, not full Opus |
| Background code edits | `model: "sonnet"` | Clear instructions, sonnet sufficient |
| Design decisions / complex refactors | `model: "opus"` or omit | Requires deep reasoning |

---

## Domain expertise

| Scenario | Agent / Skill |
|---|---|
| PAY.JP integration design, payment flow, fee handling, PCI scope | `voltagent-domains:payment-integration` |
| Subscription billing accuracy, fraud risk, regulatory edge cases | `voltagent-domains:fintech-engineer` |
| API contract docs (OpenAPI, REST guidelines) | `voltagent-domains:api-documenter` |

## Language / framework

| Scenario | Agent |
|---|---|
| Advanced TypeScript (generics, type-level, end-to-end type safety) | `voltagent-lang:typescript-pro` |
| React 18+ state, hooks, performance optimization | `voltagent-lang:react-specialist` |
| Modern JavaScript (ES2023+, async patterns) | `voltagent-lang:javascript-pro` |

## Database

| Scenario | Agent |
|---|---|
| PostgreSQL query/index/replication tuning, advanced PG features | `voltagent-data-ai:postgres-pro` |
| Cross-DB query optimization | `voltagent-data-ai:database-optimizer` |

## Infrastructure

| Scenario | Agent |
|---|---|
| Docker image / Compose hardening, multi-stage builds | `voltagent-infra:docker-expert` |
| CI/CD pipeline design or fix | `voltagent-infra:devops-engineer` |
| Deep security architecture (zero-trust, threat modeling) | `voltagent-infra:security-engineer` |

## QA & Security

| Scenario | Agent / Skill |
|---|---|
| Frontend accessibility (WCAG) audit | `voltagent-qa-sec:accessibility-tester` |
| Deep security audit beyond `security-guidance` hook | `voltagent-qa-sec:security-auditor` |
| Test framework / fixture / harness design | `voltagent-qa-sec:test-automator` |
| Performance bottlenecks (DB, app, infra) | `voltagent-qa-sec:performance-engineer` |
| Bug root cause / log correlation | `voltagent-qa-sec:debugger` or `:error-detective` |

## Behavioral discipline (`superpowers` skills)

Auto-trigger when patterns match. Invoke via Skill tool.

| Scenario | Skill |
|---|---|
| Implementing any feature or bugfix | `superpowers:test-driven-development` |
| Before claiming work complete / before commit/PR | `superpowers:verification-before-completion` |
| Encountering bug, test failure, or unexpected behavior | `superpowers:systematic-debugging` |
| Multi-step plan needed before touching code | `superpowers:writing-plans` |
| Executing a written implementation plan | `superpowers:executing-plans` |
| 2+ independent tasks (parallel) | `superpowers:dispatching-parallel-agents` |
| Major creative work (new feature, design choice) | `superpowers:brainstorming` |
| Receiving / processing PR review feedback | `superpowers:receiving-code-review` |
| Requesting code review before merge | `superpowers:requesting-code-review` |

## Frontend debugging (`chrome-devtools-mcp`)

| Scenario | Skill |
|---|---|
| WCAG / a11y issues (semantic HTML, ARIA, contrast, focus) | `chrome-devtools-mcp:a11y-debugging` |
| LCP / Core Web Vitals optimization | `chrome-devtools-mcp:debug-optimize-lcp` |
| Browser automation connection / target issues | `chrome-devtools-mcp:troubleshooting` |
| General DevTools-driven debugging (network, perf, DOM) | `chrome-devtools-mcp:chrome-devtools` |

## Already covered elsewhere

| Scope | Tool | Source |
|---|---|---|
| Business logic (Pure Core + Shell) | VCSDD pipeline `/vcsdd-*` | CLAUDE.md |
| Per-Issue feature impl | `/feature-dev`, `/ralph-loop` | workflow.md |
| Frontend implementation | `/ui-ux-pro-max` + `/frontend-design` (併用必須) | workflow.md |
| Code review chain | `/code-review` → `/pr-review-toolkit:review-pr` → `pr-review-toolkit:code-simplifier` | workflow.md |
| Git/PR ops | `/commit-commands:*` | workflow.md |
| Security on Edit/Write | `security-guidance` hook (auto) | workflow.md |
