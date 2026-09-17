# Patent → LinkedIn Ledger

Find the people behind US patents and their LinkedIn profiles.

1. Search US patents by keywords, company, filing date and technology class (CPC).
2. The tool lists every inventor on the matching patents, with city and state.
3. Click **Find LinkedIn** on an inventor (or run it for the first N inventors). Each match gets a
   score: **Strong** (70+), **Likely** (45 to 69) or **Check** (below 45, verify by hand).
4. Save good matches to the **Ledger** tab, add notes, and export CSV or JSON.

## What it runs on

| Piece | What it is | Cost |
| --- | --- | --- |
| Node.js 20.9 or newer, npm, Git | Needed to install and run it | Free |
| Next.js 16, React 19, Tailwind CSS 4 | The app itself; installed by `npm install` | Free |
| USPTO Patent Public Search | Patent data. No account or key | Free |
| People Data Labs (PDL) | LinkedIn lookup, tried first | Free tier ~100 lookups/month; charged only when it finds someone |
| Apify | LinkedIn lookup through Google search, tried when PDL finds nothing | Free plan includes $5/month; about $0.01 per lookup |
| Apollo (optional) | Another lookup source, between PDL and Apify | Needs a plan with API access |
| Vercel (optional) | Hosting it on the web with a login | Hobby or Pro |

You need at least one lookup key (PDL or Apify). Both is best: PDL is fast and precise, Apify
catches people PDL misses.

## Getting the keys

- **People Data Labs:** create a free account at https://dashboard.peopledatalabs.com (no card
  needed) and copy your API key from the dashboard.
- **Apify:** create an account at https://console.apify.com, then open **Settings → API &
  Integrations** and copy your personal API token.
- **Apollo (optional):** an API key from Apollo's settings. Leave it out if you don't have a plan
  with API access; the tool skips providers without a key.

## Run it on your computer

```bash
git clone patent-ledger.bundle patent-ledger   # or clone from your own Git host
cd patent-ledger
npm install
cp .env.example .env.local                      # then paste your keys into .env.local
npm run dev
```

Open http://localhost:3104. Locally there is no login: `PATENT_LEDGER_TRUST_LOCAL=1` lets the app
use your keys, and the dev server only listens on your own machine.

To check everything still works after a change (uses fake services, spends nothing):

```bash
npm run build
npm run smoke
```

## Host it with a login (Vercel)

1. Pick a password and hash it: `node scripts/hash-password.mjs 'your-password'`
2. Create the project: `npx vercel link` (sign in to your Vercel account when asked).
3. Add these environment variables for Production (`npx vercel env add NAME production`, or the
   Vercel dashboard):
   - `PDL_API_KEY`, `APIFY_TOKEN` (and `APOLLO_API_KEY` if you have one)
   - `PATENT_LEDGER_USERS` = `{"admin":"<the hash from step 1>"}` (add more usernames the same way)
   - `PATENT_LEDGER_SESSION_SECRET` = 32 or more random characters
   - Do **not** set `PATENT_LEDGER_TRUST_LOCAL` there.
4. Deploy: `npx vercel deploy --prod`

Everyone who signs in uses your keys, so share the login only with people you trust.

## Good to know

- A search for 25 patents takes about 25 seconds and 50 about a minute: the USPTO allows roughly
  one full patent record every two seconds after a quick first batch, and the tool stays under
  that limit.
- If the USPTO search is down, the tool falls back to Google Patents, then to Google Patents
  through Apify.
- The ledger is saved in your browser. Export it regularly; clearing browser data clears it.
- Common names (for example "Li Wang") often need a manual check. Use the candidate dropdown or
  **Search manually** under the match.
- Saving named people with their employer and location is personal data. Keep that in mind if the
  list feeds outreach.

Technical details (query formats, scoring, fallbacks): `docs/patent-ledger.md`.
