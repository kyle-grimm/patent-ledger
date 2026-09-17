import type {
  Candidate,
  EnrichAttempt,
  EnrichProvider,
  EnrichRequest,
  EnrichResponse,
  EnrichTarget,
  LedgerKeys,
} from "./types";
import { UPSTREAM } from "./upstream";
import { normaliseName } from "./patentsview";
import { employerFromAssignee, employerMatch } from "./company";

/**
 * "Light" enrichment: one lookup per provider, stop at the first match.
 *
 *  - PDL Person Enrichment  GET /v5/person/enrich  (X-Api-Key). `required=linkedin_url`
 *    means a hit without a LinkedIn URL is a 404 and is not billed.
 *  - Apollo People Match    POST /api/v1/people/match (x-api-key). No email reveal.
 *  - Apify                  POST /v2/acts/{actor}/run-sync-get-dataset-items?token=
 *    Default actor is apify~google-search-scraper. One run searches two site:linkedin.com/in
 *    queries: "First Last" + employer brand, and "First Last" alone (people change jobs).
 *    A custom actor + input template can be supplied.
 */

export const DEFAULT_PROVIDERS: EnrichProvider[] = ["pdl", "apollo", "apify"];
export const DEFAULT_APIFY_ACTOR = "apify~google-search-scraper";

type Json = Record<string, unknown>;

export async function enrichInventor(
  req: EnrichRequest,
  keys: LedgerKeys,
): Promise<EnrichResponse> {
  const providers = (req.providers?.length ? req.providers : DEFAULT_PROVIDERS).filter(
    (p, i, arr) => arr.indexOf(p) === i,
  );
  const target = normaliseTarget(req.inventor);
  const attempts: EnrichAttempt[] = [];
  const candidates: Candidate[] = [];

  for (const provider of providers) {
    const started = Date.now();
    const key = keyFor(provider, keys);
    if (!key) {
      attempts.push({ provider, status: "skipped", detail: "no API key", ms: 0 });
      continue;
    }
    try {
      const found =
        provider === "pdl"
          ? await viaPdl(target, key, req.minLikelihood ?? 6)
          : provider === "apollo"
            ? await viaApollo(target, key)
            : await viaApify(target, key, req.apify);
      const ms = Date.now() - started;
      if (found.length) {
        candidates.push(...found);
        attempts.push({ provider, status: "match", detail: `${found.length} candidate(s)`, ms });
        break; // light mode: first provider with a hit wins
      }
      attempts.push({ provider, status: "no_match", ms });
    } catch (err) {
      attempts.push({
        provider,
        status: "error",
        detail: err instanceof Error ? err.message : String(err),
        ms: Date.now() - started,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return { best: candidates[0], candidates, attempts };
}

function keyFor(provider: EnrichProvider, keys: LedgerKeys): string | undefined {
  return provider === "pdl" ? keys.pdl : provider === "apollo" ? keys.apollo : keys.apify;
}

function normaliseTarget(t: EnrichTarget): Required<Pick<EnrichTarget, "firstName" | "lastName" | "fullName">> & EnrichTarget {
  const firstName = (t.firstName || "").trim();
  const lastName = (t.lastName || "").trim();
  return {
    ...t,
    firstName,
    lastName,
    fullName: (t.fullName || `${firstName} ${lastName}`).trim(),
    assignee: t.assignee?.trim() || undefined,
  };
}

/* ────────────────────────── PDL ────────────────────────── */

async function viaPdl(t: ReturnType<typeof normaliseTarget>, apiKey: string, minLikelihood: number): Promise<Candidate[]> {
  const params = new URLSearchParams();
  params.set("first_name", t.firstName);
  params.set("last_name", t.lastName);
  if (t.assignee) params.set("company", t.assignee);
  if (t.city) params.set("locality", t.city);
  if (t.state) params.set("region", t.state);
  if (t.country) params.set("country", t.country);
  params.set("min_likelihood", String(clamp(minLikelihood, 1, 10)));
  params.set("required", "linkedin_url");
  params.set("pretty", "false");

  const res = await fetch(`${UPSTREAM.pdl}/v5/person/enrich?${params}`, {
    headers: { "X-Api-Key": apiKey, Accept: "application/json" },
    cache: "no-store",
  });
  if (res.status === 404) return [];
  if (res.status === 401 || res.status === 403) throw new Error(`PDL rejected the API key (${res.status}).`);
  if (res.status === 402) throw new Error("PDL: out of credits (402).");
  if (res.status === 429) throw new Error("PDL rate limit (429).");
  if (!res.ok) throw new Error(`PDL error ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const body = (await res.json()) as { likelihood?: number; data?: Json };
  const d = body.data || {};
  const linkedinUrl = normaliseLinkedIn(str(d.linkedin_url));
  if (!linkedinUrl) return [];
  const location =
    str(d.location_name) ||
    [str(d.location_locality), str(d.location_region), str(d.location_country)].filter(Boolean).join(", ") ||
    undefined;
  const c: Candidate = {
    provider: "pdl",
    linkedinUrl,
    fullName: str(d.full_name),
    title: str(d.job_title),
    company: str(d.job_company_name),
    location,
    likelihood: typeof body.likelihood === "number" ? body.likelihood : undefined,
    score: 0,
    reasons: [],
  };
  return [score(c, t)];
}

/* ───────────────────────── Apollo ──────────────────────── */

async function viaApollo(t: ReturnType<typeof normaliseTarget>, apiKey: string): Promise<Candidate[]> {
  const body: Json = {
    first_name: t.firstName,
    last_name: t.lastName,
    reveal_personal_emails: false,
    reveal_phone_number: false,
  };
  if (t.assignee) body.organization_name = t.assignee;

  const res = await fetch(`${UPSTREAM.apollo}/api/v1/people/match`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, Accept: "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (res.status === 401 || res.status === 403) throw new Error(`Apollo rejected the API key (${res.status}).`);
  if (res.status === 422) throw new Error("Apollo: request rejected (422). people/match may need a master API key on your plan.");
  if (res.status === 429) throw new Error("Apollo rate limit (429).");
  if (!res.ok) throw new Error(`Apollo error ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = (await res.json()) as { person?: Json | null };
  const p = data.person;
  if (!p) return [];
  const linkedinUrl = normaliseLinkedIn(str(p.linkedin_url));
  if (!linkedinUrl) return [];
  const org = (p.organization ?? {}) as Json;
  const c: Candidate = {
    provider: "apollo",
    linkedinUrl,
    fullName: str(p.name) || [str(p.first_name), str(p.last_name)].filter(Boolean).join(" "),
    title: str(p.title),
    company: str(org.name) || str(p.organization_name),
    location: [str(p.city), str(p.state), str(p.country)].filter(Boolean).join(", ") || undefined,
    score: 0,
    reasons: [],
  };
  return [score(c, t)];
}

/* ───────────────────────── Apify ───────────────────────── */

async function viaApify(
  t: ReturnType<typeof normaliseTarget>,
  token: string,
  cfg: EnrichRequest["apify"],
): Promise<Candidate[]> {
  const actorId = (cfg?.actorId || DEFAULT_APIFY_ACTOR).trim().replace("/", "~");
  const location = [t.city, t.state].filter(Boolean).join(", ");
  const employer = employerFromAssignee(t.assignee, t.fullName);
  // Patents carry middle names and initials that profiles rarely show; search first + last only.
  const givenNames = t.firstName.split(/\s+/).filter((w) => w.replace(/\./g, "").length > 1);
  const searchName = [givenNames[0] || t.firstName.split(/\s+/)[0], t.lastName].filter(Boolean).join(" ");
  // Some people do use every given name on their profile ("Yashar Zeiynali Farid").
  const longName = givenNames.length > 1 ? [...givenNames, t.lastName].join(" ") : undefined;
  const queries = [
    employer.brand ? `site:linkedin.com/in "${searchName}" ${employer.brand}` : undefined,
    `site:linkedin.com/in "${searchName}"`,
    longName ? `site:linkedin.com/in "${longName}"` : undefined,
  ].filter((q): q is string => !!q);
  const query = queries[0];
  const vars: Record<string, string> = {
    firstName: t.firstName,
    lastName: t.lastName,
    fullName: t.fullName,
    company: employer.brand || t.assignee || "",
    location,
    query,
  };
  const url = `${UPSTREAM.apify}/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}&timeout=90&memory=512&format=json&clean=true`;
  const googleInput = (qs: string[]): Json => ({
    queries: qs.join("\n"),
    maxPagesPerQuery: 1,
    resultsPerPage: 10,
    countryCode: "us",
    mobileResults: false,
  });

  let items: unknown[];
  if (cfg?.input) {
    items = await runApifyActor(url, actorId, fillTemplate(cfg.input, vars) as Json);
  } else {
    items = await runApifyActor(url, actorId, googleInput(queries));
    // The actor occasionally drops a query's results page from an otherwise successful run.
    const returned = new Set(items.map((it) => str(((it as Json).searchQuery as Json | undefined)?.term)));
    const missing = queries.filter((q) => !returned.has(q));
    if (missing.length) items = items.concat(await runApifyActor(url, actorId, googleInput(missing)));
  }
  const found: Candidate[] = [];
  for (const hit of extractLinkedInHits(items)) {
    const c: Candidate = {
      provider: "apify",
      linkedinUrl: hit.url,
      fullName: hit.name,
      title: hit.title,
      company: hit.company,
      location: hit.location,
      score: 0,
      reasons: [],
    };
    found.push(score(c, t, hit.snippet));
  }
  // Only keep plausible people: first name (or initial) and last name must both match.
  return found
    .filter((c) => c.reasons.some((r) => r.startsWith("name") && r !== "name: last only"))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

async function runApifyActor(url: string, actorId: string, input: Json): Promise<unknown[]> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
      cache: "no-store",
    });
    if (res.status === 401 || res.status === 403) throw new Error(`Apify rejected the token (${res.status}).`);
    if (res.status === 404) throw new Error(`Apify actor "${actorId}" not found (404).`);
    if (res.status === 408) throw new Error("Apify run timed out (408).");
    if ([502, 503, 504].includes(res.status) && attempt < 2) continue; // transient gateway error
    if (!res.ok) throw new Error(`Apify error ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as unknown;
    return Array.isArray(body) ? body : [];
  }
}

interface LinkedInHit {
  url: string;
  name?: string;
  title?: string;
  company?: string;
  location?: string;
  /** Result title + description, used as fallback evidence for the employer. */
  snippet?: string;
}

/** Pull LinkedIn profile hits from either Google-search items or LinkedIn-scraper items. */
export function extractLinkedInHits(items: unknown): LinkedInHit[] {
  const out: LinkedInHit[] = [];
  const byUrl = new Map<string, LinkedInHit>();
  const push = (h: LinkedInHit) => {
    const u = normaliseLinkedIn(h.url);
    if (!u) return;
    const prev = byUrl.get(u);
    if (!prev) {
      const hit = { ...h, url: u };
      byUrl.set(u, hit);
      out.push(hit);
      return;
    }
    // The same profile often appears under several queries, each with a different snippet;
    // keep every piece of evidence rather than whichever query's result arrived first.
    prev.name ||= h.name;
    prev.title ||= h.title;
    prev.company ||= h.company;
    prev.location ||= h.location;
    if (h.snippet && !prev.snippet?.includes(h.snippet)) {
      prev.snippet = [prev.snippet, h.snippet].filter(Boolean).join(" · ");
    }
  };

  for (const item of Array.isArray(items) ? (items as Json[]) : []) {
    const organic = Array.isArray(item.organicResults) ? (item.organicResults as Json[]) : null;
    if (organic) {
      for (const r of organic) {
        const url = str(r.url);
        if (!url || !/linkedin\.com\/in\//i.test(url)) continue;
        push(parseGoogleProfileResult(url, r));
      }
      continue;
    }
    // Generic LinkedIn scraper output: look for a profile URL-ish field.
    const url =
      str(item.linkedinUrl) || str(item.linkedin_url) || str(item.profileUrl) || str(item.url) || str(item.publicProfileUrl);
    if (url && /linkedin\.com\/in\//i.test(url)) {
      const loc = item.location;
      push({
        url,
        name:
          str(item.fullName) || str(item.name) || [str(item.firstName), str(item.lastName)].filter(Boolean).join(" ") || undefined,
        title: str(item.headline) || str(item.title) || str(item.jobTitle),
        company: str(item.companyName) || str(item.company) || str((item.currentPosition as Json)?.companyName),
        location: typeof loc === "string" ? loc : str((loc as Json)?.linkedinText),
      });
    }
  }
  return out;
}

/**
 * Google LinkedIn results come in several shapes:
 *   title  "Jane Doe - Senior Engineer - Meta | LinkedIn" · "Jane Doe - Staff Researcher at GM R&D"
 *          · "Jane Doe - Mountain View, California, United States"
 *   description "… · Experience: Meta · Education: … · Location: Redmond · 500+ connections"
 *   personalInfo { companyName, jobTitle, location } (when Google shows the profile card)
 */
function parseGoogleProfileResult(url: string, r: Json): LinkedInHit {
  const rawTitle = (str(r.title) || "").replace(/\s*[|–-]\s*(LinkedIn|Professional Profile)\s*$/i, "");
  const description = str(r.description) || "";
  const info = (r.personalInfo ?? {}) as Json;
  // Google truncates long titles with "..."; a clipped segment is not a usable title or company.
  const parts = rawTitle
    .split(/\s+[-–]\s+/)
    .map((p) => p.trim())
    .filter((p) => p && !/(\.\.\.|…)$/.test(p));
  const siteName = str(r.websiteTitle)?.match(/LinkedIn\s*·\s*(.+)$/i)?.[1]?.trim();

  let title = str(info.jobTitle);
  let company = str(info.companyName) || labelled(description, "Experience");
  let location = str(info.location) || labelled(description, "Location");
  const rest = parts.slice(1);
  rest.forEach((part, i) => {
    const at = part.match(/^(.+?)\s+at\s+(.+)$/i);
    if (at) {
      title ||= at[1];
      company ||= at[2];
    } else if (/^[^,]+(,\s*[^,]+){2,3}$|\b(Area|United States|United Kingdom)$/.test(part)) {
      location ||= part;
    } else if (rest.length > 1 && i === 0) {
      title ||= part; // "Name - Title - Company"
    } else {
      company ||= part; // "Name - Company" or the last segment
    }
  });
  return {
    url,
    name: siteName || parts[0] || undefined,
    title,
    company,
    location,
    snippet: [rawTitle, description].filter(Boolean).join(" · "),
  };
}

/** labelled("… · Experience: Meta · Location: Redmond", "Experience") → "Meta" */
function labelled(description: string, label: string): string | undefined {
  return description.match(new RegExp(`\\b${label}:\\s*([^·]+?)\\s*(?:·|$)`))?.[1]?.trim() || undefined;
}

function fillTemplate(v: unknown, vars: Record<string, string>): unknown {
  if (typeof v === "string") return v.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");
  if (Array.isArray(v)) return v.map((x) => fillTemplate(x, vars));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Json).map(([k, x]) => [k, fillTemplate(x, vars)]));
  }
  return v;
}

/* ───────────────────────── Scoring ─────────────────────── */

/**
 * 0–100 confidence that a candidate is the inventor.
 * name 0–40 · company 0–35 · location 0–15 · provider likelihood 0–10.
 */
export function score(c: Candidate, t: EnrichTarget, snippet?: string): Candidate {
  let s = 0;
  const reasons: string[] = [];
  const wantFirst = normaliseName(t.firstName || "").split(" ")[0] || "";
  const wantLast = normaliseName(t.lastName || "");
  const gotTokens = normaliseName(c.fullName || "").split(" ").filter(Boolean);

  if (gotTokens.length) {
    const lastOk = !!wantLast && gotTokens.includes(wantLast.split(" ").pop() || "");
    // A shared first letter only counts when one side is a bare initial ("S. Lee") or one name
    // is a short form of the other ("Tom"/"Thomas"); "Somin" is not "Suk".
    const firstOk =
      !!wantFirst &&
      gotTokens.some(
        (tok) =>
          tok === wantFirst ||
          ((tok.length === 1 || wantFirst.length === 1) && tok[0] === wantFirst[0]) ||
          (Math.min(tok.length, wantFirst.length) >= 3 && (tok.startsWith(wantFirst) || wantFirst.startsWith(tok))),
      );
    if (lastOk && firstOk && gotTokens.includes(wantFirst)) {
      s += 40;
      reasons.push("name: exact");
    } else if (lastOk && firstOk) {
      s += 30;
      reasons.push("name: last + initial");
    } else if (lastOk) {
      s += 15;
      reasons.push("name: last only");
    }
  } else if (c.linkedinUrl) {
    // No name from the provider; infer from the slug.
    const slug = c.linkedinUrl.split("/in/")[1]?.split(/[/?#]/)[0]?.replace(/-\w*\d\w*$/, "") || "";
    const slugNorm = slug.replace(/-/g, " ");
    if (wantLast && slugNorm.includes(wantLast)) {
      s += wantFirst && slugNorm.includes(wantFirst) ? 30 : 15;
      reasons.push("name: from URL slug");
    }
  }

  const employer = employerFromAssignee(t.assignee, t.fullName);
  const companyHit = employerMatch(employer, c.company);
  if (companyHit === 1) {
    s += 35;
    reasons.push("company: match");
  } else if (employerMatch(employer, snippet) === 1) {
    s += 25;
    reasons.push("company: in search snippet");
  } else if (companyHit === 0.5) {
    s += 15;
    reasons.push("company: partial");
  }

  const loc = normaliseName(c.location || "");
  if (loc) {
    if (t.city && loc.includes(normaliseName(t.city))) {
      s += 15;
      reasons.push("location: city");
    } else if (t.state && stateNames(t.state).some((st) => new RegExp(`\\b${st}\\b`).test(loc))) {
      s += 8;
      reasons.push("location: state");
    }
  }

  if (typeof c.likelihood === "number") {
    s += Math.round(clamp(c.likelihood, 0, 10));
    reasons.push(`pdl likelihood ${c.likelihood}`);
  }

  return { ...c, score: clamp(s, 0, 100), reasons };
}

/** Patents give US states as codes ("MI"); LinkedIn spells them out ("Michigan"). Match either. */
const US_STATES: Record<string, string> = {
  AL: "alabama", AK: "alaska", AZ: "arizona", AR: "arkansas", CA: "california", CO: "colorado", CT: "connecticut",
  DE: "delaware", DC: "district of columbia", FL: "florida", GA: "georgia", HI: "hawaii", ID: "idaho", IL: "illinois",
  IN: "indiana", IA: "iowa", KS: "kansas", KY: "kentucky", LA: "louisiana", ME: "maine", MD: "maryland",
  MA: "massachusetts", MI: "michigan", MN: "minnesota", MS: "mississippi", MO: "missouri", MT: "montana", NE: "nebraska",
  NV: "nevada", NH: "new hampshire", NJ: "new jersey", NM: "new mexico", NY: "new york", NC: "north carolina",
  ND: "north dakota", OH: "ohio", OK: "oklahoma", OR: "oregon", PA: "pennsylvania", RI: "rhode island",
  SC: "south carolina", SD: "south dakota", TN: "tennessee", TX: "texas", UT: "utah", VT: "vermont", VA: "virginia",
  WA: "washington", WV: "west virginia", WI: "wisconsin", WY: "wyoming",
};

function stateNames(state: string): string[] {
  const code = state.trim().toUpperCase();
  // A bare two-letter code like "in" or "or" is too ambiguous to find in free text; use the name.
  return US_STATES[code] ? [US_STATES[code]] : [normaliseName(state)];
}

export function normaliseLinkedIn(url?: string): string | undefined {
  if (!url) return undefined;
  let u = url.trim();
  if (!u) return undefined;
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  try {
    const parsed = new URL(u);
    if (!/(^|\.)linkedin\.com$/i.test(parsed.hostname)) return undefined;
    const path = parsed.pathname.replace(/\/+$/, "");
    if (!/^\/in\/[^/]+/.test(path)) return undefined;
    return `https://www.linkedin.com${path.split("/").slice(0, 3).join("/")}`;
  } catch {
    return undefined;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
