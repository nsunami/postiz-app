# Agent Instructions

This repository is **Postiz**, a social media scheduling tool. The complete,
authoritative project rules live in [`CLAUDE.md`](./CLAUDE.md) at the repo root.
**Read it in full before making changes.** This file only summarizes the rules
that are most expensive to get wrong.

## Essentials

- **Package manager:** pnpm only (pnpm 10, Node 22). Never use npm or yarn.
- **Monorepo layout:**
  - `apps/backend` — NestJS API
  - `apps/orchestrator` — Temporal background workflows/activities
  - `apps/frontend` — Vite + React
  - `libraries/` — shared services and components (most server logic lives in `libs/server`)
- **Backend layering:** DTO → Controller → Service → Repository. No shortcuts.
  Controllers stay thin; real logic belongs in `libraries/`.
- **Database:** Prisma only. Never write raw SQL.
- **Frontend:** use SWR via the `useFetch` hook, one hook per query, obey
  `react-hooks/rules-of-hooks` (never disable it). Prefer existing native
  components over new npm packages. Reuse patterns from `components/ui` and
  existing components; follow `colors.scss`, `global.scss`, and
  `tailwind.config.js`. Do not use deprecated `--color-custom*` variables.
- **Temporal:** never modify a workflow or activity already on `origin/main`.
  Add a new versioned workflow/activity instead. Workflow/activity parameters
  are immutable.
- **Genericity:** no provider-specific logic in generic code. Extend the
  provider interface and implement per provider.
- **Production safety:** the system has real users. Never change the meaning or
  format of persisted data without asking. Check all consumers before changing
  a shared `select` or return shape. Never return raw Prisma rows holding
  credentials (`Integration`, `User`, etc.).
- **Webhooks:** payment-provider webhook code (Stripe, RevenueCat, ...) must
  never throw — catch and log failures so billing state is not left half-applied.
- **PRs:** follow `.github/PULL_REQUEST_TEMPLATE.md` exactly. Every PR needs a
  `# QA` section with real numbered steps (`1. [ ] ...`), and the change-type
  section must describe the concrete change, not just "Bug fix." / "Feature.".
- Verify changes against existing code patterns; match the surrounding style
  rather than inventing new patterns.
