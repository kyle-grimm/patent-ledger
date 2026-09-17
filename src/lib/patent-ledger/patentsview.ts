import type {
  Inventor,
  Patent,
  PatentInventorRef,
  SearchRequest,
  SearchResponse,
} from "./types";
import { UPSTREAM } from "./upstream";

/**
 * PatentsView PatentSearch API (search.patentsview.org/api/v1/patent/).
 * Free key required (X-Api-Key). ~45 requests/minute.
 * Query language: {_and:[...]}, {_text_all:{field:"words"}}, {_begins:{field:"prefix"}},
 * {_gte:{patent_date:"YYYY-MM-DD"}}, {_contains:{field:"text"}}.
 */

const FIELDS = [
  "patent_id",
  "patent_title",
  "patent_abstract",
  "patent_date",
  "patent_type",
  "application.filing_date",
  "inventors.inventor_id",
  "inventors.inventor_name_first",
  "inventors.inventor_name_last",
  "inventors.inventor_city",
  "inventors.inventor_state",
  "inventors.inventor_country",
  "assignees.assignee_organization",
  "assignees.assignee_individual_name_first",
  "assignees.assignee_individual_name_last",
  "cpc_current.cpc_group_id",
];

type Json = Record<string, unknown>;

/** Reduce "https://www.meta.com/" or "meta.com" to "meta"; leave plain names alone. */
export function assigneeSearchText(input?: string): string | undefined {
  const raw = input?.trim();
  if (!raw) return undefined;
  const noScheme = raw.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0];
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(noScheme)) {
    const labels = noScheme.split(".");
    // Drop TLD (and a second-level ccTLD like co.uk).
    const drop = labels.length >= 3 && labels[labels.length - 2].length <= 3 ? 2 : 1;
    return labels.slice(0, labels.length - drop).pop() || labels[0];
  }
  return raw;
}

export function buildPatentsViewQuery(req: SearchRequest): Json {
  const words = req.query.trim();
  const textOp = req.mode === "any" ? "_text_any" : "_text_all";
  const clauses: Json[] = [];

  if (words) {
    clauses.push({
      _or: [{ [textOp]: { patent_title: words } }, { [textOp]: { patent_abstract: words } }],
    });
  }

  const cpc = (req.cpcPrefixes || []).map((c) => c.trim()).filter(Boolean);
  if (cpc.length) {
    clauses.push({ _or: cpc.map((p) => ({ _begins: { "cpc_current.cpc_group_id": p } })) });
  }

  const assignee = assigneeSearchText(req.assignee);
  if (assignee) {
    clauses.push({ _contains: { "assignees.assignee_organization": assignee } });
  }

  if (req.dateFrom) clauses.push({ _gte: { patent_date: req.dateFrom } });
  if (req.dateTo) clauses.push({ _lte: { patent_date: req.dateTo } });

  if (clauses.length === 0) return { _gte: { patent_date: "1976-01-01" } };
  return clauses.length === 1 ? clauses[0] : { _and: clauses };
}

export async function searchPatentsView(
  req: SearchRequest,
  apiKey: string,
): Promise<SearchResponse> {
  const size = Math.min(Math.max(req.size ?? 50, 1), 500);
  const body = {
    q: buildPatentsViewQuery(req),
    f: FIELDS,
    o: { size },
    s: [{ patent_date: "desc" }],
  };

  const res = await fetch(`${UPSTREAM.patentsview}/api/v1/patent/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  if (res.status === 403) throw new Error("PatentsView rejected the API key (403).");
  if (res.status === 429) throw new Error("PatentsView rate limit hit (45 req/min). Wait a minute and retry.");
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new Error(`PatentsView error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    error?: boolean;
    total_hits?: number;
    count?: number;
    patents?: Json[] | null;
  };
  if (data.error) throw new Error("PatentsView returned error=true.");

  const patents = (data.patents || []).map(mapPatent);
  return {
    source: "patentsview",
    totalHits: data.total_hits ?? patents.length,
    patents,
    inventors: aggregateInventors(patents),
    warnings: [],
  };
}

function mapPatent(p: Json): Patent {
  const id = String(p.patent_id ?? "");
  const inventors: PatentInventorRef[] = (asArray(p.inventors) as Json[]).map((i) => ({
    inventorId: optStr(i.inventor_id),
    firstName: optStr(i.inventor_name_first) || "",
    lastName: optStr(i.inventor_name_last) || "",
    city: optStr(i.inventor_city),
    state: optStr(i.inventor_state),
    country: optStr(i.inventor_country),
  }));
  const assignees = (asArray(p.assignees) as Json[])
    .map(
      (a) =>
        optStr(a.assignee_organization) ||
        [optStr(a.assignee_individual_name_first), optStr(a.assignee_individual_name_last)]
          .filter(Boolean)
          .join(" "),
    )
    .filter(Boolean);
  const cpc = (asArray(p.cpc_current) as Json[]).map((c) => optStr(c.cpc_group_id) || "").filter(Boolean);
  const app = (p.application && typeof p.application === "object" ? p.application : {}) as Json;
  const appFirst = Array.isArray(p.application) ? ((p.application[0] as Json) ?? {}) : app;

  return {
    id,
    title: optStr(p.patent_title) || "(untitled)",
    abstract: optStr(p.patent_abstract),
    date: optStr(p.patent_date),
    filingDate: optStr(appFirst.filing_date),
    assignees: dedupe(assignees),
    cpc: dedupe(cpc),
    inventors,
    url: `https://patents.google.com/patent/US${id}`,
    source: "patentsview",
  };
}

/** Collapse patents → one row per inventor, keyed by PatentsView inventor_id (or normalised name). */
export function aggregateInventors(patents: Patent[]): Inventor[] {
  const map = new Map<string, Inventor & { assigneeCounts: Map<string, number> }>();

  for (const patent of patents) {
    for (const inv of patent.inventors) {
      const fullName = `${inv.firstName} ${inv.lastName}`.trim();
      if (!fullName) continue;
      const key = inv.inventorId || `name:${normaliseName(fullName)}`;
      let row = map.get(key);
      if (!row) {
        row = {
          key,
          inventorId: inv.inventorId,
          firstName: inv.firstName,
          lastName: inv.lastName,
          fullName,
          city: inv.city,
          state: inv.state,
          country: inv.country,
          assignees: [],
          patentIds: [],
          patentCount: 0,
          latestDate: undefined,
          source: patent.source,
          assigneeCounts: new Map(),
        };
        map.set(key, row);
      }
      if (!row.patentIds.includes(patent.id)) {
        row.patentIds.push(patent.id);
        row.patentCount = row.patentIds.length;
      }
      // Prefer the most recent location we have seen.
      if (patent.date && (!row.latestDate || patent.date > row.latestDate)) {
        row.latestDate = patent.date;
        if (inv.city) row.city = inv.city;
        if (inv.state) row.state = inv.state;
        if (inv.country) row.country = inv.country;
      }
      for (const a of patent.assignees) {
        row.assigneeCounts.set(a, (row.assigneeCounts.get(a) || 0) + 1);
      }
    }
  }

  return [...map.values()]
    .map(({ assigneeCounts, ...row }) => {
      const sorted = [...assigneeCounts.entries()].sort((a, b) => b[1] - a[1]);
      return { ...row, assignees: sorted.map(([a]) => a), assignee: sorted[0]?.[0] };
    })
    .sort((a, b) => b.patentCount - a.patentCount || a.lastName.localeCompare(b.lastName));
}

export function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function optStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
