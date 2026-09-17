import { normaliseName } from "./patentsview";

/**
 * Patent assignees are legal/IP-holding entities ("GM Global Technology Operations LLC",
 * "Microsoft Technology Licensing", "Facebook Technologies"). People list the employer
 * brand on LinkedIn ("General Motors", "Microsoft", "Meta"). These helpers bridge the two.
 */

/** Brand renames and parent names a legal assignee string cannot reveal. Keys match normalised text. */
const BRAND_ALIASES: ReadonlyArray<readonly [RegExp, string, string[], string[]]> = [
  // [pattern on normalised assignee or user input, employer brand, extra names that count as the
  //  same employer, how the company appears as a patent assignee]
  [/\b(facebook|oculus|meta platforms|^meta$)\b/, "Meta", ["facebook", "oculus", "reality labs"], ["meta platforms", "facebook technologies", "oculus"]],
  [/\b(gm global|general motors|^gm$)/, "General Motors", ["gm"], ["general motors", "gm global"]],
  [/\b(ford global|ford motor|^ford$)/, "Ford", ["ford motor"], ["ford global", "ford motor"]],
  [/\b(fuji jukogyo|subaru)\b/, "Subaru", ["fuji heavy"], ["subaru", "fuji jukogyo"]],
  [/\bapical\b/, "Arm", ["apical"], ["apical"]],
  [/\bsony interactive\b/, "Sony Interactive Entertainment", ["playstation"], ["sony interactive"]],
  [/\bx development\b/, "Google X", ["google", "alphabet"], ["x development"]],
  [/\bgoogle\b/, "Google", ["alphabet", "deepmind"], ["google"]],
  [/\blawrence livermore\b/, "Lawrence Livermore National Laboratory", ["llnl"], ["lawrence livermore"]],
  [/\bsikorsky\b/, "Sikorsky", ["lockheed martin"], ["sikorsky"]],
];

/**
 * Names to search the patent assignee field for, given what a person typed:
 * "General Motors" → ["general motors", "gm global"], "Apple" → ["apple"].
 */
export function assigneeSearchVariants(input: string | undefined): string[] {
  const norm = normaliseName(decodeEntities(input || ""));
  if (!norm) return [];
  for (const [pattern, , , assigneeNames] of BRAND_ALIASES) {
    if (pattern.test(norm)) return assigneeNames;
  }
  return [norm];
}

/** Trailing words that describe the legal/IP wrapper rather than the employer. */
const WRAPPER_TAIL =
  /(\s+(global technology operations|global technologies|technology licensing|licensing|intellectual property|ip holdings|patent holdings|holdings|research foundation|foundation|technologies|technology|operations|engineering|manufacturing|motors|motor|europe|north america|america|usa|us|inc|incorporated|llc|l l c|ltd|limited|corp|corporation|co|company|gmbh|ag|sa|plc|kk|kabushiki kaisha|b v|bv|nv|n v|s a))+$/;

const GENERIC = new Set([
  "inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation", "co", "company",
  "technologies", "technology", "tech", "holdings", "group", "platforms", "international",
  "the", "of", "and", "gmbh", "ag", "sa", "plc", "kk", "kabushiki", "kaisha", "labs", "laboratories",
  "laboratory", "global", "operations", "licensing", "university", "research", "foundation",
  "institute", "national", "solutions", "solution", "systems", "system", "america", "north",
  "europe", "usa", "general", "motor", "motors", "engineering", "manufacturing", "security", "services",
]);

export interface Employer {
  /** Name to put in a web search, or undefined when the assignee is not a usable employer. */
  brand?: string;
  /** Distinctive token sets; a candidate matching all tokens of any set is the same employer. */
  names: string[][];
  /** Distinctive words of the assignee itself; overlap with these earns partial credit. */
  core: string[];
}

export function employerFromAssignee(assignee: string | undefined, inventorName?: string): Employer {
  const raw = decodeEntities(assignee || "")
    .replace(/(…|\.\.\.)\s*$/, "")
    .trim();
  const norm = normaliseName(raw);
  const none: Employer = { names: [], core: [] };
  if (!norm) return none;
  // Government assignees and self-assigned inventors say nothing about an employer.
  if (/^(the )?united states\b/.test(norm) || /\bas represented by\b/.test(norm)) return none;
  if (inventorName && norm === normaliseName(inventorName)) return none;

  const names: string[][] = [];
  let brand: string | undefined;
  for (const [pattern, aliasBrand, extra] of BRAND_ALIASES) {
    if (pattern.test(norm)) {
      brand = aliasBrand;
      // Curated names keep every word ("general motors", not just "general").
      names.push(tokens(aliasBrand, false), ...extra.map((x) => tokens(x, false)));
      break;
    }
  }

  const stripped = norm.replace(WRAPPER_TAIL, "").trim();
  if (!brand) brand = titleCase(stripped || norm);
  const core = tokens(stripped || norm);
  names.push(core);
  return { brand, names: names.filter((n) => n.length), core: core.filter((tok) => !isGeneric(tok)) };
}

/** 1 = same employer, 0.5 = partial overlap, 0 = no evidence. */
export function employerMatch(employer: Employer, text: string | undefined): number {
  if (!employer.names.length || !text) return 0;
  const got = new Set(tokens(text, false));
  if (!got.size) return 0;
  if (employer.names.some((n) => n.every((tok) => got.has(tok)))) return 1;
  // Partial credit only for distinctive words of the assignee, never "general" or "systems".
  return employer.core.some((tok) => got.has(tok)) ? 0.5 : 0;
}

function isGeneric(tok: string): boolean {
  return GENERIC.has(tok) || GENERIC.has(tok + "s");
}

function tokens(s: string, dropGeneric = true): string[] {
  return normaliseName(s)
    .split(" ")
    .filter((w) => w.length > 1 && !(dropGeneric && GENERIC.has(w)))
    .map(singular);
}

function singular(w: string): string {
  return w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function decodeEntities(s: string): string {
  return s
    .replace(/&hellip;/g, "…")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&[a-z]+;/g, " ");
}
