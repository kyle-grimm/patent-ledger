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

## Change log

- **2026-09-17 — LinkedIn X-ray Search, Apify accuracy tuning, Max patents input.** Kyle's fork
  (his own GitHub/Vercel, not Connor's). Three related-but-separate changes, all in
  `PatentLedgerClient.tsx` / `enrich.ts` / `types.ts`:
  - **"LinkedIn X-ray Search"**: a persistent green button under "Find LinkedIn" on every inventor
    row (visible in every state, not just after a match/no-match) — opens
    `site:linkedin.com <name> <search keywords> <raw assignee>` in Google in a new tab. Deliberately
    a manual link, not an automated provider — no cost, no scraping, just a faster path to the same
    kind of check "Search manually" already did with a narrower `site:linkedin.com/in "name"
    brand` query. The two links are complementary (broader site scope + raw assignee vs. the
    brand-mapped one), kept side by side.
  - **Apify enrichment accuracy**: `viaApify` in `enrich.ts` had `countryCode: "us"` hardcoded on
    every Google search, even though a large share of inventors on multinational engineering
    patents (verified against Kyle's own GM battery-patent search: Zhe Li, Qili Su, Haijing Liu, all
    Shanghai) are outside the US — now derived from the inventor's own `country` field, defaulting
    to `"us"` only when absent. Also added an extra `name + brand + <patent's own search
    keywords>` query (purely additive alongside the existing name+brand and name-only queries,
    never a replacement) to help disambiguate common names within the specific technical field —
    threaded through as a new `EnrichRequest.searchQuery` field, populated client-side from the
    same `query` state the patent search box uses. **Verified against a real, hard case (Zhe Li,
    an extremely common Chinese name)**: the fix correctly returned only "Check"-tier candidates
    (score 40, name-only match, no company/location evidence) rather than confidently guessing
    wrong — the scoring gate is working as intended; a name this common will always need manual
    verification regardless of search targeting. The earlier real test on a distinctive name
    (Xingcheng Xiao) already scored a confident 83 before any of this session's changes, and
    remains the more representative case most engineering-patent inventors will hit.
  - **Max patents**: the old 25/50/100 `<select>` is now a `type="number"` input, `min={1}
    max={100}`, with a custom `onWheel` handler so hovering + scrolling steps the value (not just
    the native focused-input scroll behavior) — server-side clamping in `uspto-ppubs.ts`/
    `google-patents.ts`/`apify-patents.ts` already enforced `[1, 100]`, so no server change needed.
  - All three verified via `npm run build && npm run smoke` (52/52 checks) after each change, plus
    real (non-mocked) API calls for the X-ray query shape and the Apify accuracy fix specifically —
    not just the mocked smoke suite.

## Auth and keys
- Hosted: set `PATENT_LEDGER_USERS` (JSON of username → hash from `scripts/hash-password.mjs`)
  and `PATENT_LEDGER_SESSION_SECRET`. Login is then required everywhere; routes re-verify the session
  before using server keys.
- Local: leave `PATENT_LEDGER_USERS` unset and set `PATENT_LEDGER_TRUST_LOCAL=1`; scripts bind to
  127.0.0.1. Never set `PATENT_LEDGER_TRUST_LOCAL` on a hosted install. `.vercelignore` keeps
  `.env.local` out of Vercel uploads.
- The ledger is per-browser (localStorage); users do not share saved rows.
- The smoke test drives the UI by button text, `data-tab`, and LinkedIn `a[href]` selectors.
