# PAY.JP Hosted/Redirect Option Note

## Purpose

This note preserves a future architecture option for moving from the current `payjp.js iframe` integration toward a more hosted or redirect-oriented payment flow.

It does **not** change the current source-of-truth specs.
For MVP and near-term PCI-readiness work, the project continues to use the existing `payjp.js iframe` approach described in:

- [docs/2weeks-spec.md](docs/2weeks-spec.md)
- [docs/implementation-design-mvp.md](docs/implementation-design-mvp.md)
- [docs/tdd-acceptance-matrix-mvp.md](docs/tdd-acceptance-matrix-mvp.md)

## Current MVP Baseline

The current system assumes:

- browser-side card entry via `PAY.JP.js` iframe/Elements
- client-side tokenization with 3DS
- backend-side `customer -> charge -> subscription` orchestration on PAY.JP API v1
- webhook-driven subscription state sync
- `operationId` fail-close recovery rules

Key repo evidence:

- [frontend/member.html](frontend/member.html) (payment SPA host at `/member`)
- [frontend/src/main.ts](frontend/src/main.ts)
- [packages/billing-service/src/shell/subscribe.ts](packages/billing-service/src/shell/subscribe.ts)
- [packages/server/src/main.ts](packages/server/src/main.ts)

## Why Hosted/Redirect Is Attractive

- A PAY.JP-hosted payment page can reduce merchant-side explanation burden around browser-page script governance.
- It may simplify PCI review narratives compared with a merchant-hosted payment page that loads third-party payment scripts.
- It can reduce pressure to justify every payment-page script and client-side control on the merchant domain.

## Why It Is Not The Immediate Default

## 1. The current source-of-truth specs fix iframe mode

The current functional and design specs explicitly assume `PAY.JP.js` iframe-based payment entry and state that redirect mode is not supported in MVP.

Relevant evidence:

- [docs/2weeks-spec.md](docs/2weeks-spec.md)
- [docs/implementation-design-mvp.md](docs/implementation-design-mvp.md)

## 2. This product depends on recurring billing

The product is not a simple one-time payment flow. It requires:

- plan-based recurring billing
- first-charge plus trial handling
- later subscription cancel/resume/status sync
- operation-safe reconciliation

The current implementation uses PAY.JP API v1 subscription primitives directly.

Relevant evidence:

- [docs/2weeks-spec.md](docs/2weeks-spec.md)
- [packages/billing-service/src/shell/subscribe.ts](packages/billing-service/src/shell/subscribe.ts)
- [packages/server/src/main.ts](packages/server/src/main.ts)

## 3. PAY.JP hosted products do not map cleanly onto the current recurring design

Based on the official PAY.JP documentation reviewed during planning:

- Checkout v2 is a hosted redirect flow for payment pages
- Setup Flow can host payment-method registration pages
- PAY.JP API v2 documentation states recurring billing is not yet supported there
- PAY.JP API v1 and v2 can coexist, but v2-created payment methods are not directly usable from v1 in the general case described by the docs

This means a naive migration such as:

- `hosted setup in v2`
- then `subscription creation in v1`

cannot be assumed to work safely without a deeper product/API migration plan.

## Architecture Options

## Option A: Keep current `payjp.js iframe` flow

### Pros

- Lowest implementation risk
- Matches current specs and code
- Preserves current UX
- Keeps existing 3DS, `operationId`, webhook, and resync logic intact

### Cons

- Requires stronger merchant-side evidence for script governance and page integrity
- Needs operational evidence, compensating controls, and review-ready documentation

## Option B: Migrate to hosted/redirect for payment entry

### Pros

- Cleaner PCI review narrative for payment-page ownership
- Potentially smaller browser-side merchant attack surface

### Cons

- Requires source-of-truth spec changes
- Likely requires redesign of subscribe success/cancel/error flow
- May require broader PAY.JP v1/v2 migration strategy, not just frontend replacement
- Risks incompatibility with current recurring billing flow

## Recommended Near-Term Position

For now, keep the current `payjp.js iframe` architecture and strengthen:

- PCI evidence collection
- payment-page script inventory and justification
- tamper/change-detection compensating controls
- deployment/runtime proof for headers, MFA, ASV, and operational checks

Treat hosted/redirect migration as a separate future initiative, not a quick hardening patch.

## Revisit Conditions

Revisit the hosted/redirect path when at least one of the following becomes true:

- PAY.JP API v2 recurring billing is fully supported and production-ready
- PAY.JP documents a supported migration path from hosted setup/checkout into recurring subscriptions matching our requirements
- the team accepts a spec change that modifies the current UX and recovery model
- PCI review pressure makes the current merchant-hosted payment page materially harder to justify than a larger rearchitecture

## Related PCI Readiness Docs (current iframe path)

These documents support the **current** `payjp.js iframe` approach and do not change the specs:

- [compliance/pci-readiness-gap-matrix.md](compliance/pci-readiness-gap-matrix.md) — requirement classification
- [compliance/pci-readiness-summary.md](compliance/pci-readiness-summary.md) — short verdict and labels
- [compliance/pci-payment-page-monitoring.md](compliance/pci-payment-page-monitoring.md) — compensating controls for page integrity

## If Revisited Later

Before any implementation starts, prepare a Change Request that updates all three source-of-truth docs:

1. [docs/2weeks-spec.md](docs/2weeks-spec.md)
2. [docs/implementation-design-mvp.md](docs/implementation-design-mvp.md)
3. [docs/tdd-acceptance-matrix-mvp.md](docs/tdd-acceptance-matrix-mvp.md)

Questions to resolve at that time:

- Which PAY.JP product is the actual target: Checkout v1, Checkout v2, Setup Flow, or another hosted flow?
- How will recurring subscription creation work end-to-end?
- How will `operationId` and fail-close guarantees be preserved?
- How will Discord prechecks fit into the redirect timing?
- What new webhook and return-page states are required?
