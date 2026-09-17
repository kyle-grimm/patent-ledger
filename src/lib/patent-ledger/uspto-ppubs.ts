import type { Patent, PatentInventorRef, SearchRequest, SearchResponse } from "./types";
import { UPSTREAM } from "./upstream";
import { aggregateInventors, assigneeSearchText } from "./patentsview";
import { assigneeSearchVariants } from "./company";

/**
 * USPTO Patent Public Search (ppubs.uspto.gov), the API behind the USPTO's own search app.
 * No account or key: an anonymous session hands out an access token. Unofficial in the sense
 * that it is undocumented, but it is the USPTO's service, it carries full inventor names with
 * city/state/country, and it is not subject to Google's rate limiting. Verified 2026-09-16:
 *
 *   POST /api/users/me/session                 body "-1" → header x-access-token, userCase.caseId
 *   POST /api/searches/searchWithBeFamily      BRS query → patents[] (inventorsShort only)
 *   GET  /api/patents/highlight/{guid}         full record: inventorsName[], inventorCity[], …
 *
 * BRS syntax used: `(a AND b).ti,ab.`, `(H01M10$ OR G02B27/01$).cpc.`,
 * `("general motors" OR (gm ADJ global)).as.`, `@ad>=20180101` (application filing date).
 */

type Json = Record<string, unknown>;

const DETAIL_CONCURRENCY = 4;
const MAX_RATE_LIMIT_RETRIES = 8;
const SESSION_TTL_MS = 25 * 60 * 1000; // the service times sessions out after 30 minutes

let session: { token: string; caseId: number; expires: number } | undefined;

export class UsptoUnavailableError extends Error {}

export async function searchUsptoPatents(req: SearchRequest): Promise<SearchResponse> {
  const size = Math.min(Math.max(req.size ?? 50, 1), 100);
  const q = usptoQuery(req);
  if (!q) throw new Error("Enter keywords, a CPC code, or a company.");

  const search = (await call("POST", "/api/searches/searchWithBeFamily", (s) => searchBody(q, size, s.caseId))) as Json;
  // The service can return a few more rows than pageCount; each row costs a rate-limited record call.
  const rows = (Array.isArray(search.patents) ? (search.patents as Json[]) : []).slice(0, size);

  const patents: Patent[] = [];
  let failedDetails = 0;
  for (let i = 0; i < rows.length; i += DETAIL_CONCURRENCY) {
    const batch = rows.slice(i, i + DETAIL_CONCURRENCY);
    const details = await Promise.all(
      batch.map((row) =>
        call("GET", `/api/patents/highlight/${encodeURIComponent(String(row.guid))}?queryId=0&source=${encodeURIComponent(String(row.type || "USPAT"))}&includeSections=false&uniqueId=`)
          .then((d) => d as Json)
          .catch(() => {
            failedDetails++;
            return undefined;
          }),
      ),
    );
    batch.forEach((row, k) => {
      const p = mapPatent(row, details[k]);
      if (p) patents.push(p);
    });
  }

  const warnings = failedDetails
    ? [`USPTO returned partial records for ${failedDetails} patent(s); only their first inventor is listed.`]
    : [];
  return {
    source: "uspto",
    totalHits: typeof search.numFound === "number" ? search.numFound : patents.length,
    patents,
    inventors: aggregateInventors(patents),
    warnings,
  };
}

/* ───────────────────────── query ───────────────────────── */

const BRS_OPERATORS = new Set(["and", "or", "not", "xor", "adj", "near", "with", "same"]);

/** Words (and "quoted phrases") to BRS terms; hyphenated words become adjacency. */
function terms(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const words = (m[1] ?? m[2])
      .split(/[^A-Za-z0-9]+/)
      .map((w) => w.toLowerCase())
      .filter((w) => w && !BRS_OPERATORS.has(w));
    if (words.length) out.push(words.length > 1 ? `(${words.join(" ADJ ")})` : words[0]);
  }
  return out;
}

export function usptoQuery(req: SearchRequest): string {
  const parts: string[] = [];

  const kw = terms(req.query || "");
  if (kw.length) parts.push(`(${kw.join(req.mode === "any" ? " OR " : " AND ")}).ti,ab.`);

  const cpc = (req.cpcPrefixes ?? [])
    .map((c) => c.trim().toUpperCase().replace(/[^A-Z0-9/]/g, ""))
    .filter(Boolean)
    .map((c) => `${c}$`);
  if (cpc.length) parts.push(`(${cpc.join(" OR ")}).cpc.`);

  const company = assigneeSearchText(req.assignee);
  const variants = assigneeSearchVariants(company).flatMap((v) => {
    const t = terms(`"${v}"`);
    return t.length ? t : [];
  });
  if (variants.length) parts.push(`(${variants.join(" OR ")}).as.`);

  const day = (d?: string) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d.replace(/-/g, "") : undefined);
  if (day(req.dateFrom)) parts.push(`@ad>=${day(req.dateFrom)}`);
  if (day(req.dateTo)) parts.push(`@ad<=${day(req.dateTo)}`);

  return parts.join(" AND ");
}

function searchBody(q: string, size: number, caseId: number): Json {
  return {
    start: 0,
    pageCount: size,
    sort: "date_publ desc",
    docFamilyFiltering: "familyIdFiltering",
    searchType: 1,
    familyIdEnglishOnly: true,
    familyIdFirstPreferred: "USPAT",
    familyIdSecondPreferred: "US-PGPUB",
    familyIdThirdPreferred: "FPRS",
    showDocPerFamilyPref: "showEnglish",
    queryId: 0,
    tagDocSearch: false,
    query: {
      caseId,
      hl_snippets: "2",
      op: "AND",
      q,
      queryName: q,
      highlights: "0",
      qt: "brs",
      spellCheck: false,
      viewName: "tile",
      plurals: true,
      britishEquivalents: true,
      databaseFilters: [
        { databaseName: "USPAT", countryCodes: [] },
        { databaseName: "US-PGPUB", countryCodes: [] },
      ],
      searchType: 1,
      ignorePersist: true,
      userEnteredQuery: q,
    },
  };
}

/* ───────────────────────── transport ───────────────────────── */

const BROWSER_HEADERS = {
  Accept: "application/json",
  Origin: "https://ppubs.uspto.gov",
  Referer: "https://ppubs.uspto.gov/pubwebapp/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
};

async function getSession(force = false) {
  if (!force && session && session.expires > Date.now()) return session;
  const res = await fetch(`${UPSTREAM.uspto}/api/users/me/session`, {
    method: "POST",
    headers: { ...BROWSER_HEADERS, "Content-Type": "application/json" },
    body: "-1",
    cache: "no-store",
  });
  const token = res.headers.get("x-access-token");
  if (!res.ok || !token) throw new UsptoUnavailableError(`USPTO patent search could not start a session (${res.status}).`);
  const body = (await res.json()) as { userCase?: { caseId?: number } };
  session = { token, caseId: body.userCase?.caseId ?? 0, expires: Date.now() + SESSION_TTL_MS };
  return session;
}

/**
 * Token bucket just inside the USPTO's limit, shared by all callers in this server process.
 * Measured 2026-09-16: a burst of ~21 requests, then one every 2 s sustained (1.5 s spacing got
 * 6 of 14 refused). So ~25 patents load in about 10 s and 50 in about a minute.
 */
const BUCKET_CAPACITY = 18;
const REFILL_MS = 2100;
let tokens = BUCKET_CAPACITY;
let lastRefill = Date.now();
let queue: Promise<void> = Promise.resolve();
function paced(): Promise<void> {
  const turn = queue.then(async () => {
    const now = Date.now();
    tokens = Math.min(BUCKET_CAPACITY, tokens + (now - lastRefill) / REFILL_MS);
    lastRefill = now;
    if (tokens < 1) {
      const wait = (1 - tokens) * REFILL_MS;
      await new Promise((r) => setTimeout(r, wait));
      tokens = 1;
      lastRefill = Date.now();
    }
    tokens -= 1;
  });
  queue = turn;
  return turn;
}

async function call(method: "GET" | "POST", path: string, body?: (s: { caseId: number }) => Json): Promise<unknown> {
  let renewed = false;
  for (let rateLimited = 0; ; ) {
    await paced();
    const s = await getSession();
    const res = await fetch(`${UPSTREAM.uspto}${path}`, {
      method,
      headers: { ...BROWSER_HEADERS, "Content-Type": "application/json", "X-Access-Token": s.token },
      body: body ? JSON.stringify(body(s)) : undefined,
      cache: "no-store",
    });
    if ((res.status === 401 || res.status === 403) && !renewed) {
      // Expired session. Renew once; concurrent callers pick up the new token from the cache.
      renewed = true;
      if (session?.token === s.token) await getSession(true);
      continue;
    }
    if (res.status === 429 && rateLimited < MAX_RATE_LIMIT_RETRIES) {
      // Measured 2026-09-16: ~22 record requests per ~8 s, then 429 with x-rate-limit-retry-after-seconds.
      rateLimited++;
      const seconds = Number(res.headers.get("x-rate-limit-retry-after-seconds")) || 1;
      await new Promise((r) => setTimeout(r, seconds * 1000 + 750 * rateLimited));
      continue;
    }
    if (res.status === 429) throw new UsptoUnavailableError("USPTO patent search is rate-limiting requests (429).");
    if (!res.ok) throw new UsptoUnavailableError(`USPTO patent search error ${res.status}.`);
    return res.json();
  }
}

/* ───────────────────────── mapping ───────────────────────── */

function mapPatent(row: Json, detail: Json | undefined): Patent | undefined {
  const guid = str(row.guid) || str(detail?.guid);
  if (!guid) return undefined;
  const id = guid.replace(/-/g, "");
  const d = detail ?? row;

  const names = strings(d.inventorsName);
  const cities = arr(d.inventorCity);
  const states = arr(d.inventorState);
  const countries = arr(d.inventorCountry);
  const inventors: PatentInventorRef[] = names.length
    ? names.map((n, i) => ({ ...splitName(n), city: clean(cities[i]), state: clean(states[i]), country: clean(countries[i]) }))
    : firstInventorFromShort(str(row.inventorsShort));

  const cpc = [str(d.cpcInventiveFlattened), str(d.cpcAdditionalFlattened)]
    .filter(Boolean)
    .join(";")
    .split(";")
    .map((c) => c.trim())
    .filter(Boolean);

  return {
    id,
    title: stripTags(str(d.inventionTitle) || str(row.inventionTitle) || "(untitled)"),
    abstract: stripTags(str(d.abstractHtml) || "") || undefined,
    date: str(d.datePublished)?.slice(0, 10),
    filingDate: (strings(d.applicationFilingDate)[0] || str(d.applicationFilingDate))?.slice(0, 10),
    assignees: strings(d.assigneeName).length ? strings(d.assigneeName) : strings(row.assigneeName),
    cpc: [...new Set(cpc)],
    inventors,
    url: `https://patents.google.com/patent/${id}`,
    source: "uspto",
  };
}

/** "Yersak; Thomas A" → { firstName: "Thomas A", lastName: "Yersak" } */
function splitName(n: string): PatentInventorRef {
  const [last, first] = n.split(";").map((s) => s.trim());
  return first ? { firstName: first, lastName: last } : { firstName: last, lastName: "" };
}

/** "Li; Zhe et al." → first inventor only. */
function firstInventorFromShort(s: string | undefined): PatentInventorRef[] {
  if (!s) return [];
  return [splitName(s.replace(/\s+et al\.?$/i, ""))];
}

function clean(v: unknown): string | undefined {
  const s = str(v);
  return s && s.toUpperCase() !== "N/A" ? s : undefined;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function strings(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean);
  const s = str(v);
  return s ? [s] : [];
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
