# Patent → LinkedIn Ledger

Internal research tool (Next.js 16, React 19, Tailwind 4). Search US patents, group the inventors,
match each inventor to a LinkedIn profile, save matches to a ledger, export CSV.
Full technical docs: `docs/patent-ledger.md`. Setup for people: `README.md`.

- Dev: `npm run dev` → http://localhost:3104/tools/patent-ledger
- After touching code: `npm run build && npm run smoke` (mock upstreams, no real credits spent).
- Machine-specific notes (deploy targets, where credentials live) go in `CLAUDE.local.md`, which is
  gitignored.
- Next.js 16 renamed Middleware to Proxy (`src/proxy.ts`); read `node_modules/next/dist/docs/`
  before assuming older Next.js APIs.

## Upstreams (as of 2026-09-16)
- **Patent search:** USPTO Patent Public Search first (`uspto-ppubs.ts`: free, no key, inventor
  locations; paced to its limit of ~1 record per 2 s after a ~20 burst. Respect the limit, never
  rotate sessions to get around it). Then Google Patents direct, then Google Patents via Apify
  (`apify-patents.ts`). Google rate-limits an IP after a few dozen searches.
- **PatentsView API is retired** (`search.patentsview.org` no longer resolves; patentsview.org
  redirects to the USPTO Open Data Portal, which has no replacement API yet). Its code path only
  runs if a key is supplied.
- **LinkedIn lookup:** People Data Labs → Apollo → Apify Google search, first match wins.
  PDL charges only for matches. Apify costs about $0.01 per lookup; keep evals small on a free plan.
- Apify matching details and eval numbers are in `docs/patent-ledger.md`. Known gaps: nicknames
  ("Venkat" for Venkataramani), transliterated names, people with no LinkedIn. Add company renames
  to `BRAND_ALIASES` in `company.ts`.

## Auth and keys
- Hosted: set `PATENT_LEDGER_USERS` (JSON of username → hash from `scripts/hash-password.mjs`)
  and `PATENT_LEDGER_SESSION_SECRET`. Login is then required everywhere; routes re-verify the session
  before using server keys.
- Local: leave `PATENT_LEDGER_USERS` unset and set `PATENT_LEDGER_TRUST_LOCAL=1`; scripts bind to
  127.0.0.1. Never set `PATENT_LEDGER_TRUST_LOCAL` on a hosted install. `.vercelignore` keeps
  `.env.local` out of Vercel uploads.
- The ledger is per-browser (localStorage); users do not share saved rows.
- The smoke test drives the UI by button text, `data-tab`, and LinkedIn `a[href]` selectors.
