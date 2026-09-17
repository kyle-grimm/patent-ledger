import type { Patent, SearchRequest, SearchResponse } from "./types";
import { UPSTREAM } from "./upstream";
import { aggregateInventors, assigneeSearchText, normaliseName } from "./patentsview";
import { googlePatentsQueryText, toInventorRef } from "./google-patents";
import { employerFromAssignee, employerMatch } from "./company";

/**
 * Google Patents through an Apify actor, used when Google blocks this machine's direct requests.
 *
 * Actor fetch_cat/google-patents-search-scraper runs Google Patents queries from Apify's network
 * (Apify Proxy on). Verified 2026-09-16: keyword and `CPC=` query text work; `country:`,
 * `after:` and `assignee:()` do not (the last fails the run), so country, date and company are
 * filtered here instead. Cost is roughly $0.0003 per record returned.
 */
export const APIFY_PATENTS_ACTOR = "fetch_cat~google-patents-search-scraper";

type Json = Record<string, unknown>;

export async function searchPatentsViaApify(req: SearchRequest, token: string): Promise<SearchResponse> {
  const size = Math.min(Math.max(req.size ?? 50, 1), 100);
  const company = assigneeSearchText(req.assignee);
  const query = [googlePatentsQueryText(req), company].filter(Boolean).join(" ");
  // Non-US and out-of-range records are dropped below, so ask for extra.
  const maxItems = Math.min(size * 2, 200);

  const url = `${UPSTREAM.apify}/v2/acts/${APIFY_PATENTS_ACTOR}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}&timeout=120&format=json&clean=true`;
  const input = JSON.stringify({ queries: [query], maxItems, includeDetails: false, proxyConfiguration: { useApifyProxy: true } });
  let items: unknown;
  // Google sometimes refuses the proxy IP too; the actor then fails the run. A new run gets a new IP.
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: input,
      cache: "no-store",
    });
    if (res.status === 401 || res.status === 403) throw new Error(`Apify rejected the token (${res.status}).`);
    if (res.status === 408) throw new Error("Apify patent search timed out (408).");
    if (res.ok) {
      items = await res.json();
      break;
    }
    const text = await res.text();
    const retryable = (res.status === 400 && /run-failed/.test(text)) || res.status >= 500;
    if (!retryable || attempt >= 3) {
      throw new Error(
        retryable
          ? "Google Patents refused the Apify search three times. Wait a few minutes and search again."
          : `Apify patent search error ${res.status}: ${text.slice(0, 200)}`,
      );
    }
  }

  const rows = Array.isArray(items) ? (items as Json[]) : [];

  const patents = rows
    .filter((x) => inRange(str(x.filingDate) || str(x.priorityDate) || str(x.publicationDate), req.dateFrom, req.dateTo))
    .map(mapItem)
    .filter((p): p is Patent => !!p && /^US/i.test(p.id))
    .filter((p) => !company || p.assignees.some((a) => sameCompany(a, company)))
    .slice(0, size);

  return {
    source: "google-patents-apify",
    totalHits: patents.length,
    patents,
    inventors: aggregateInventors(patents),
    warnings: [],
  };
}

function mapItem(x: Json): Patent | undefined {
  const id = str(x.publicationNumber) || str(x.patentId);
  if (!id) return undefined;
  const classifications = Array.isArray(x.classifications) ? (x.classifications as unknown[]) : [];
  return {
    id,
    title: str(x.patentTitle) || "(untitled)",
    abstract: str(x.abstract) || str(x.snippet),
    date: str(x.grantDate) || str(x.publicationDate),
    filingDate: str(x.filingDate),
    assignees: strings(x.assignees).length ? strings(x.assignees) : strings(x.assignee),
    cpc: classifications
      .map((c) => (typeof c === "string" ? c : str((c as Json)?.code)))
      .filter((c): c is string => !!c && /^[A-HY]\d{2}[A-Z]/.test(c)),
    inventors: (strings(x.inventors).length ? strings(x.inventors) : strings(x.inventor)).map(toInventorRef),
    url: str(x.patentUrl) || `https://patents.google.com/patent/${id}`,
    source: "google-patents-apify",
  };
}

/** "General Motors" or "GM" matches the assignee "GM Global Technology Operations LLC". */
function sameCompany(assignee: string, wanted: string): boolean {
  // Whole words only: "GM" must not match "Sigma Designs".
  if (` ${normaliseName(assignee)} `.includes(` ${normaliseName(wanted)} `)) return true;
  return employerMatch(employerFromAssignee(assignee), wanted) === 1 || employerMatch(employerFromAssignee(wanted), assignee) === 1;
}

function inRange(date: string | undefined, from?: string, to?: string): boolean {
  if (!date) return !from && !to;
  const d = date.slice(0, 10);
  return (!from || d >= from) && (!to || d <= to);
}

function strings(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((s) => (typeof s === "string" ? s.trim() : "")).filter(Boolean);
  const s = str(v);
  return s ? [s] : [];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
