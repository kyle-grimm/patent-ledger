/**
 * Patent → LinkedIn ledger: shared types between the API routes and the UI.
 *
 * Flow: search patents (PatentsView, falling back to Google Patents) →
 * aggregate inventors → enrich one inventor at a time (PDL → Apollo → Apify)
 * → user saves matches to a ledger kept in their browser.
 */

export type PatentSource = "uspto" | "patentsview" | "google-patents" | "google-patents-apify";

export type EnrichProvider = "pdl" | "apollo" | "apify";

export interface PatentInventorRef {
  inventorId?: string;
  firstName: string;
  lastName: string;
  city?: string;
  state?: string;
  country?: string;
}

export interface Patent {
  id: string;
  title: string;
  abstract?: string;
  /** Grant date (YYYY-MM-DD) when known. */
  date?: string;
  filingDate?: string;
  assignees: string[];
  cpc: string[];
  inventors: PatentInventorRef[];
  url: string;
  source: PatentSource;
}

export interface Inventor {
  /** Stable key within a search: PatentsView inventor_id when present, else normalised name. */
  key: string;
  inventorId?: string;
  firstName: string;
  lastName: string;
  fullName: string;
  city?: string;
  state?: string;
  country?: string;
  /** Most frequent assignee across this inventor's matched patents. */
  assignee?: string;
  assignees: string[];
  patentIds: string[];
  patentCount: number;
  latestDate?: string;
  source: PatentSource;
}

export interface SearchRequest {
  query: string;
  /** "all" = every word must appear (default). "any" = at least one word. */
  mode?: "all" | "any";
  /** CPC group prefixes, e.g. "G02B27/01". Applied as an OR. PatentsView only. */
  cpcPrefixes?: string[];
  /** Company name or web domain. A domain is reduced to its label ("meta.com" → "meta"). */
  assignee?: string;
  dateFrom?: string;
  dateTo?: string;
  size?: number;
  source?: "auto" | PatentSource;
}

export interface SearchResponse {
  source: PatentSource;
  totalHits: number;
  patents: Patent[];
  inventors: Inventor[];
  warnings: string[];
}

export interface EnrichTarget {
  firstName: string;
  lastName: string;
  fullName?: string;
  city?: string;
  state?: string;
  country?: string;
  assignee?: string;
}

export interface EnrichRequest {
  inventor: EnrichTarget;
  /** Providers to try, in order. Stops at the first provider that yields a match. */
  providers?: EnrichProvider[];
  /** PDL min_likelihood (1–10). Default 6. */
  minLikelihood?: number;
  /** The patent search's own keywords. Apify adds one extra name+company+keywords query with this. */
  searchQuery?: string;
  /** Optional custom Apify actor. Defaults to apify~google-search-scraper (site:linkedin.com/in search). */
  apify?: {
    actorId?: string;
    /** JSON input template. Strings may contain {firstName} {lastName} {fullName} {company} {location} {query}. */
    input?: Record<string, unknown>;
  };
}

export interface Candidate {
  provider: EnrichProvider;
  linkedinUrl?: string;
  fullName?: string;
  title?: string;
  company?: string;
  location?: string;
  /** Provider-native confidence when it has one (PDL likelihood 1–10). */
  likelihood?: number;
  /** Our 0–100 match score against the inventor record. */
  score: number;
  reasons: string[];
}

export interface EnrichAttempt {
  provider: EnrichProvider;
  status: "match" | "no_match" | "skipped" | "error";
  detail?: string;
  ms: number;
}

export interface EnrichResponse {
  best?: Candidate;
  candidates: Candidate[];
  attempts: EnrichAttempt[];
}

export interface LedgerKeys {
  patentsview?: string;
  pdl?: string;
  apollo?: string;
  apify?: string;
}
