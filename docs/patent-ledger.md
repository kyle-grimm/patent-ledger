# Patent → LinkedIn ledger (`/tools/patent-ledger`)

Internal research tool. Search US patents by topic, CPC technology class, or company, group the
inventors, and match each inventor to a LinkedIn profile using the enrichment keys you already
hold. Confirmed matches go into a ledger you can export as CSV.

`noindex`; `robots.ts` disallows everything. `/` redirects to the tool.

## How it works

1. **Patent search** — `POST /api/patent-ledger/search`
   - **PatentsView PatentSearch API**, only when a key is present. The public API was retired into
     the USPTO Open Data Portal in 2026 (`search.patentsview.org` no longer resolves), so this
     path normally does not run; the code stays for when the USPTO ships a replacement.
   - **USPTO Patent Public Search** (`src/lib/patent-ledger/uspto-ppubs.ts`), the default. The
     API behind ppubs.uspto.gov: no account or key, an anonymous session returns an
     `x-access-token`. `POST /api/searches/searchWithBeFamily` with a BRS query
     (`(solid AND state).ti,ab. AND (H01M10$).cpc. AND ("general motors" OR (gm ADJ global)).as.
     AND @ad>=20180101`), then `GET /api/patents/highlight/{guid}` per patent for full inventor
     names with city/state/country. Company names go through `assigneeSearchVariants` so
     "General Motors" also searches "GM Global". Dates are application filing dates. The service
     allows a burst of ~21 record calls, then one every 2 s (measured 2026-09-16), so a token
     bucket paces calls and 429s are retried using `x-rate-limit-retry-after-seconds`: 25 patents
     take about 25 s, 50 about a minute. Covers granted patents (USPAT) and applications
     (US-PGPUB), one document per family.
   - **Google Patents** XHR endpoint, direct and free, used if the USPTO service fails. Keywords plus CPC filters as query text
     (`display (CPC=G09G3 OR CPC=G09G5)`), assignee and filing-date URL params. No inventor
     locations; inventors keyed by name. Google rate-limits after a few dozen searches from one IP
     (503 "Sorry" page, seen 2026-09-16), which raises `GoogleBlockedError`.
   - **Google Patents via Apify** when Google blocks and an Apify token is available
     (`src/lib/patent-ledger/apify-patents.ts`, actor `fetch_cat~google-patents-search-scraper`
     with Apify Proxy on; without the proxy Google blocks Apify's IPs too). Keyword and `CPC=`
     text work through the actor; `country:`, `after:` and `assignee:()` do not, so US-only,
     date range and company are filtered in code and the actor is asked for twice the requested
     size. About $0.0003 per record, roughly $0.03 per 100. Settings can force either path.
   - "Company or domain" accepts `meta.com` and reduces it to `meta` for the assignee filter.
2. **Inventor grouping** — one row per PatentsView `inventor_id` (or normalised name on the
   fallback), with patent count, most-frequent assignee, latest grant date, latest location.
3. **Enrichment** — `POST /api/patent-ledger/enrich`, one inventor per call ("light" mode).
   Providers run in the order set in Settings and the **first hit wins**, so a PDL match never
   also spends an Apollo credit or an Apify run.
   - **People Data Labs** `GET /v5/person/enrich` with first/last name, company, locality,
     region, `min_likelihood` (default 6) and `required=linkedin_url` (a hit without a LinkedIn
     URL is a 404 and is not billed).
   - **Apollo** `POST /api/v1/people/match` with first/last name + `organization_name`, no
     email/phone reveal.
   - **Apify** `run-sync-get-dataset-items` on `apify~google-search-scraper`, one run with up to
     three queries: `site:linkedin.com/in "First Last" Brand`, `site:linkedin.com/in "First Last"`,
     and `"First Middle Last"` when the patent lists a middle name. Middle names and initials are
     dropped from the main queries because profiles rarely show them. A query whose results page
     the actor drops is re-run once; 502/503/504 are retried once. About $0.002 per query.
     A custom actor ID and JSON input template (placeholders
     `{firstName} {lastName} {fullName} {company} {location} {query}`, where `{company}` is the brand
     and `{query}` the first query) can be set in Settings; items with a `linkedin.com/in/` URL field
     are picked up generically.
   - **Brand** (`src/lib/patent-ledger/company.ts`): patent assignees are legal/IP entities, so
     `GM Global Technology Operations LLC` → General Motors, `Microsoft Technology Licensing` →
     Microsoft, `Facebook Technologies` → Meta (also matches Facebook/Oculus/Reality Labs). Legal
     suffixes are stripped generically; renames and parents come from a short alias list. Government
     assignees and self-assigned inventors yield no brand.
   - Google results are parsed from `personalInfo` (company, job title, location), the
     `Experience: … · Location: …` description, and `Title at Company` titles. A profile returned
     by several queries is merged so no query's evidence is lost.
   - Each candidate gets a 0–100 score: name (exact 40, initial or short form 30) + employer
     (company field 35, only in the search snippet 25, partial 15) + location (15) + PDL
     likelihood (10). Green ≥ 70, yellow ≥ 45. Apify results need first and last name to match;
     a shared first letter only counts when one side is a bare initial or a short form
     ("Tom"/"Thomas"), so "Somin Lee" is not "Suk Woo Lee".
   - Live eval, 2026-09-16, 45 inventors from three topics, Apify only: before 3/45 with any
     candidate and 0 scoring ≥ 45; after 37/45 with a candidate, 9 green and 9 yellow, all 18
     plausible on inspection. Name-only candidates stay at 40 for manual review.
4. **Ledger** — saved rows live in the browser's localStorage. Export CSV / JSON, import JSON
   (merges by row ID), free-text notes per row.

## Keys

Server-side env vars in `.env.local` (`PDL_API_KEY`, `APIFY_TOKEN`, `APOLLO_API_KEY`,
`PATENTSVIEW_API_KEY`) are used when either:

- **Hosted (login on):** `PATENT_LEDGER_USERS` is set, and the request carries a valid session
  cookie from `/login`. `src/proxy.ts` sends signed-out page requests to `/login` and returns 401
  for signed-out API calls; the routes check the session again before touching server keys.
  `PATENT_LEDGER_USERS` is JSON `{"<username>": "<hash>"}` with hashes from
  `node scripts/hash-password.mjs '<password>'`; `PATENT_LEDGER_SESSION_SECRET` (32+ random
  characters) signs the cookies. Removing a user ends their sessions.
- **Local (login off):** `PATENT_LEDGER_USERS` is unset and `PATENT_LEDGER_TRUST_LOCAL=1`.
  `npm run dev` / `npm run start` bind to 127.0.0.1, so nothing off the machine can reach the
  routes. Never set `PATENT_LEDGER_TRUST_LOCAL` on a hosted install.

`GET /api/patent-ledger/status` returns which providers the current request can use (booleans
only); the header pills and the Settings drawer read it. Keys typed into Settings override the
server keys for that browser only and travel in the `x-ledger-keys` header.

## Testing offline

`scripts/patent-ledger-mock-upstream.mjs` fakes every upstream with realistic response
shapes (USPTO, PatentsView, Google Patents, PDL, Apollo, Apify). `scripts/patent-ledger-smoke.mjs`
boots it plus `next start` with login switched on, checks the login gate, hits the routes directly
(query shapes, fallbacks, rate-limit retry, provider chaining, scoring) and then drives the real
page in headless Chromium: sign in → search → enrich three inventors (one per provider) → save →
ledger persisted. 52 checks as of 2026-09-16; no real credits are spent.

```
npm run build
npm run smoke
```

Live calls verified 2026-09-16 (locally and from Vercel): USPTO search, PDL match, Apify match.
When a provider misbehaves, open the *Attempts* dropdown under an inventor for its error.

## Known limits

- Common names will not auto-resolve; use the candidate dropdown and the "search manually" link.
- The ledger is per-browser. Export regularly. A shared store (Vercel Blob / Postgres) is the
  obvious next step if more than one person uses it.
- Storing named people with employer/location is personal data (GDPR/CCPA). Keep purpose and
  retention documented if this feeds outreach.
