/**
 * Upstream base URLs. Overridable so the mock-upstream harness
 * (scripts/patent-ledger-mock-upstream.mjs) can exercise the routes offline.
 */
export const UPSTREAM = {
  uspto: process.env.PATENT_LEDGER_USPTO_BASE || "https://ppubs.uspto.gov",
  patentsview:
    process.env.PATENT_LEDGER_PATENTSVIEW_BASE || "https://search.patentsview.org",
  googlePatents:
    process.env.PATENT_LEDGER_GOOGLE_PATENTS_BASE || "https://patents.google.com",
  pdl: process.env.PATENT_LEDGER_PDL_BASE || "https://api.peopledatalabs.com",
  apollo: process.env.PATENT_LEDGER_APOLLO_BASE || "https://api.apollo.io",
  apify: process.env.PATENT_LEDGER_APIFY_BASE || "https://api.apify.com",
};
