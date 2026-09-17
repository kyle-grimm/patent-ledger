import type { Patent, PatentInventorRef, SearchRequest, SearchResponse } from "./types";
import { UPSTREAM } from "./upstream";
import { aggregateInventors, assigneeSearchText } from "./patentsview";

/*
 * Google Patents fallback, used when the USPTO search fails. Same XHR endpoint the
 * patents.google.com UI calls: unofficial, no key, inventor names and assignee but no inventor
 * locations or stable IDs. Google rate-limits after a few dozen searches from one IP.
 */

/** Google refused the request (rate limit / "unusual traffic" page). Worth retrying elsewhere. */
export class GoogleBlockedError extends Error {}

/**
 * Keyword text plus CPC filters in Google Patents query syntax: `display (CPC=G09G3 OR CPC=G09G5)`.
 * "any" mode joins the words with OR.
 */
export function googlePatentsQueryText(req: SearchRequest): string {
  const words = req.query.trim().split(/\s+/).filter(Boolean);
  const text = req.mode === "any" && words.length > 1 ? `(${words.join(" OR ")})` : words.join(" ");
  const cpc = (req.cpcPrefixes ?? []).map((c) => c.trim()).filter(Boolean).map((c) => `CPC=${c}`);
  const cpcText = cpc.length > 1 ? `(${cpc.join(" OR ")})` : cpc[0] || "";
  return [text, cpcText].filter(Boolean).join(" ");
}

export async function searchGooglePatents(req: SearchRequest): Promise<SearchResponse> {
  const size = Math.min(Math.max(req.size ?? 50, 1), 100);
  const params: string[] = [];
  const q = googlePatentsQueryText(req);
  if (q) params.push(`q=${encodeURIComponent(q)}`);
  const assignee = assigneeSearchText(req.assignee);
  if (assignee) params.push(`assignee=${encodeURIComponent(assignee)}`);
  if (req.dateFrom) params.push(`after=filing:${req.dateFrom.replace(/-/g, "")}`);
  if (req.dateTo) params.push(`before=filing:${req.dateTo.replace(/-/g, "")}`);
  params.push(`num=${size}`);
  params.push("country=US");

  const inner = params.join("&");
  const url = `${UPSTREAM.googlePatents}/xhr/query?url=${encodeURIComponent(inner)}&exp=`;

  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
      Accept: "application/json,text/plain,*/*",
      Referer: "https://patents.google.com/",
    },
    cache: "no-store",
  });
  if (res.status === 429 || res.status === 503) throw new GoogleBlockedError(`Google Patents is rate-limiting this machine (${res.status}).`);
  if (!res.ok) throw new Error(`Google Patents error ${res.status}.`);

  const text = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new GoogleBlockedError("Google Patents returned a block page instead of results.");
  }

  const results = (data.results ?? {}) as Record<string, unknown>;
  const clusters = Array.isArray(results.cluster) ? (results.cluster as Record<string, unknown>[]) : [];
  const rows: Record<string, unknown>[] = [];
  for (const c of clusters) {
    const r = Array.isArray(c.result) ? (c.result as Record<string, unknown>[]) : [];
    for (const item of r) {
      const patent = (item.patent ?? item) as Record<string, unknown>;
      rows.push(patent);
    }
  }

  const patents = rows.map(mapRow).filter((p): p is Patent => !!p);
  const warnings: string[] = [];
  return {
    source: "google-patents",
    totalHits: Number(results.total_num_results ?? patents.length) || patents.length,
    patents,
    inventors: aggregateInventors(patents),
    warnings,
  };
}

function mapRow(p: Record<string, unknown>): Patent | undefined {
  const pub = str(p.publication_number) || str(p.patent_number);
  if (!pub) return undefined;
  const inventors = splitPeople(p.inventor ?? p.inventors).map(toInventorRef);
  const assignees = splitPeople(p.assignee ?? p.assignees);
  const title = stripTags(str(p.title) || "(untitled)");
  return {
    id: pub,
    title,
    abstract: stripTags(str(p.snippet) || "") || undefined,
    date: str(p.grant_date) || str(p.publication_date) || undefined,
    filingDate: str(p.filing_date) || undefined,
    assignees,
    cpc: [],
    inventors,
    url: `https://patents.google.com/patent/${pub}`,
    source: "google-patents",
  };
}

function splitPeople(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : str((x as Record<string, unknown>)?.name) || "")).map((s) => s.trim()).filter(Boolean);
  if (typeof v === "string") return v.split(/,\s*(?=[A-Z])/).map((s) => s.trim()).filter(Boolean);
  return [];
}

export function toInventorRef(name: string): PatentInventorRef {
  const parts = name.replace(/\s+/g, " ").trim().split(" ");
  const lastName = parts.length > 1 ? parts[parts.length - 1] : "";
  const firstName = parts.length > 1 ? parts.slice(0, -1).join(" ") : parts[0];
  return { firstName, lastName };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}
