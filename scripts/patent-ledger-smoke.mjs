#!/usr/bin/env node
/**
 * End-to-end smoke test for /tools/patent-ledger against the mock upstream.
 *
 *   npm run build && node scripts/patent-ledger-smoke.mjs
 *
 * Boots the mock upstream + `next start`, calls both API routes directly, then
 * drives the real page in headless Chromium: sets keys, searches, enriches three
 * inventors (one per provider), saves to the ledger, exports CSV.
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, scryptSync } from "node:crypto";
import puppeteer from "puppeteer";

function hashPassword(password) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("base64url")}$${scryptSync(password, salt, 32).toString("base64url")}`;
}

const MOCK_PORT = 4010;
const APP_PORT = 3104;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}`;
const KEYS = { patentsview: "pv-test-key", pdl: "pdl-test-key", apollo: "apollo-test-key", apify: "apify-test-token" };

const env = {
  ...process.env,
  PORT: String(APP_PORT),
  PATENT_LEDGER_PATENTSVIEW_BASE: MOCK,
  PATENT_LEDGER_USPTO_BASE: MOCK,
  PATENT_LEDGER_GOOGLE_PATENTS_BASE: MOCK,
  PATENT_LEDGER_PDL_BASE: MOCK,
  PATENT_LEDGER_APOLLO_BASE: MOCK,
  PATENT_LEDGER_APIFY_BASE: MOCK,
  // Login on, as on Vercel: user "tester" / "correct horse".
  PATENT_LEDGER_USERS: JSON.stringify({ tester: hashPassword("correct horse") }),
  PATENT_LEDGER_SESSION_SECRET: "smoke-test-session-secret-0123456789abcdef",
  PDL_API_KEY: "pdl-test-key",
  // Process env wins over .env.local: keep the real local keys and local trust out of the test.
  PATENT_LEDGER_TRUST_LOCAL: "0",
  APIFY_TOKEN: "",
  APOLLO_API_KEY: "",
  PATENTSVIEW_API_KEY: "",
};

const procs = [];
function run(cmd, args, extraEnv = {}) {
  // detached → own process group, so the kill below reaches the server itself, not just a wrapper.
  const p = spawn(cmd, args, { env: { ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  p.stdout.on("data", (d) => process.env.SMOKE_VERBOSE && process.stdout.write(`[${cmd}] ${d}`));
  p.stderr.on("data", (d) => process.stderr.write(`[${cmd}] ${d}`));
  procs.push(p);
  return p;
}
async function waitFor(url, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`timeout waiting for ${url}`);
}
let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

try {
  for (const port of [MOCK_PORT, APP_PORT]) {
    const busy = await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false);
    if (busy) throw new Error(`port ${port} already in use: a stale server from an earlier run is still up. Kill it first.`);
  }
  run("node", ["scripts/patent-ledger-mock-upstream.mjs", String(MOCK_PORT)]);
  run("node", ["node_modules/next/dist/bin/next", "start", "-p", String(APP_PORT)]);
  await waitFor(`${MOCK}/__log`);
  await waitFor(`${APP}/tools/patent-ledger`, 90000);

  /* ── Login ── */
  const rawFetch = globalThis.fetch;
  let r0 = await rawFetch(`${APP}/tools/patent-ledger`, { redirect: "manual" });
  check("auth: signed-out page request redirects to /login", r0.status === 307 && /\/login\?next=%2Ftools%2Fpatent-ledger$/.test(r0.headers.get("location") || ""), `${r0.status} ${r0.headers.get("location")}`);
  r0 = await rawFetch(`${APP}/api/patent-ledger/search`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "vr" }) });
  check("auth: signed-out API call → 401", r0.status === 401);
  r0 = await rawFetch(`${APP}/login`);
  check("auth: login page is public", r0.status === 200);
  r0 = await rawFetch(`${APP}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "tester", password: "wrong" }) });
  check("auth: wrong password → 401, no cookie", r0.status === 401 && !r0.headers.get("set-cookie"));
  r0 = await rawFetch(`${APP}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "Tester", password: "correct horse" }) });
  const setCookie = r0.headers.get("set-cookie") || "";
  const COOKIE = setCookie.split(";")[0];
  check("auth: right password (username case-insensitive) → httpOnly session cookie", r0.status === 200 && /^pl_session=.+\..+/.test(COOKIE) && /HttpOnly/i.test(setCookie), setCookie.slice(0, 80));
  const [payload, mac] = COOKIE.slice("pl_session=".length).split(".");
  const forged = `pl_session=${Buffer.from(JSON.stringify({ u: "tester", exp: 9999999999 })).toString("base64url")}.${mac}`;
  r0 = await rawFetch(`${APP}/api/patent-ledger/status`, { headers: { cookie: forged } });
  check("auth: tampered session cookie → 401", r0.status === 401 && payload.length > 0);
  r0 = await rawFetch(`${APP}/api/patent-ledger/status`, { headers: { cookie: COOKIE } });
  const st0 = await r0.json();
  check("auth: signed-in status reports user and server PDL key (booleans only)", st0.user === "tester" && st0.providers.pdl === true && st0.providers.apify === false && !JSON.stringify(st0).includes("pdl-test-key"), JSON.stringify(st0));

  // Every later call to the app is signed in.
  globalThis.fetch = (url, opts = {}) =>
    String(url).startsWith(APP) ? rawFetch(url, { ...opts, headers: { ...(opts.headers || {}), cookie: COOKIE } }) : rawFetch(url, opts);

  /* ── API: search via PatentsView ── */
  const hdr = { "Content-Type": "application/json", "x-ledger-keys": JSON.stringify(KEYS) };
  const hdrNoPv = () => ({ "Content-Type": "application/json", "x-ledger-keys": JSON.stringify({ ...KEYS, patentsview: undefined }) });
  let r = await fetch(`${APP}/api/patent-ledger/search`, {
    method: "POST",
    headers: hdr,
    body: JSON.stringify({ query: "high resolution display virtual reality", cpcPrefixes: ["G02B27/01"], assignee: "meta.com", dateFrom: "2018-01-01", size: 50 }),
  });
  let s = await r.json();
  check("search: 200 via patentsview", r.status === 200 && s.source === "patentsview", `${r.status} ${s.source || s.error}`);
  check("search: 2 patents → 3 inventors", s.patents?.length === 2 && s.inventors?.length === 3, `${s.patents?.length}/${s.inventors?.length}`);
  const vance = s.inventors?.find((i) => i.lastName === "Vance");
  check("search: inventor merged across patents by inventor_id", vance?.patentCount === 2 && vance?.assignee?.startsWith("Meta"), JSON.stringify({ n: vance?.patentCount, a: vance?.assignee }));
  const log = await (await fetch(`${MOCK}/__log`)).json();
  const pv = log.find((e) => e.path === "/api/v1/patent/");
  const pvBody = JSON.parse(pv.body);
  const qs = JSON.stringify(pvBody.q);
  check("search: PatentsView query has text/cpc/assignee(domain→meta)/date clauses",
    qs.includes('"_text_all"') && qs.includes('"_begins":{"cpc_current.cpc_group_id":"G02B27/01"}') && qs.includes('"assignees.assignee_organization":"meta"') && qs.includes('"_gte":{"patent_date":"2018-01-01"}'), qs);
  check("search: X-Api-Key sent", pv.headers["x-api-key"] === "pv-test-key");

  /* ── API: search falls back to Google Patents without a key ── */
  /* ── API: USPTO Patent Public Search (default without a PatentsView key) ── */
  r = await fetch(`${APP}/api/patent-ledger/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "vr display", cpcPrefixes: ["G02B27/01"], assignee: "General Motors", dateFrom: "2018-01-01", size: 25 }),
  });
  s = await r.json();
  check("search: no key → USPTO", r.status === 200 && s.source === "uspto" && s.patents?.length === 2 && s.warnings.length === 0, `${r.status} ${s.source || s.error} ${JSON.stringify(s.warnings)}`);
  const vanceUs = s.inventors?.find((i) => i.lastName === "Vance");
  check("search: USPTO inventors carry full names and locations", s.inventors?.length === 3 && vanceUs?.firstName === "Maria" && vanceUs?.city === "Redmond" && vanceUs?.state === "WA", JSON.stringify(s.inventors?.map((i) => [i.fullName, i.city, i.state])));
  check("search: USPTO patent ids and filing dates normalised", s.patents?.[0]?.id === "US11111111B2" && s.patents?.[0]?.filingDate === "2022-03-14" && s.patents?.[0]?.title === "Waveguide display", JSON.stringify(s.patents?.[0]));
  const ulog = await (await fetch(`${MOCK}/__log`)).json();
  const usq = JSON.parse(ulog.find((e) => e.path === "/api/searches/searchWithBeFamily").body).query.q;
  check("search: USPTO query has keywords, CPC prefix, brand-mapped assignee and filing date",
    usq === "(vr AND display).ti,ab. AND (G02B27/01$).cpc. AND ((general ADJ motors) OR (gm ADJ global)).as. AND @ad>=20180101", usq);
  check("search: USPTO record rate-limited once, then retried", ulog.filter((e) => e.path === "/api/patents/highlight/US-20240000001-A1").length === 2);

  r = await fetch(`${APP}/api/patent-ledger/search`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "googleonly display" }) });
  s = await r.json();
  check("search: USPTO down → google-patents with a warning", r.status === 200 && s.source === "google-patents" && s.inventors.length === 2 && s.warnings.some((w) => /USPTO/.test(w)), `${s.source} ${s.inventors?.length} ${JSON.stringify(s.warnings)}`);

  r = await fetch(`${APP}/api/patent-ledger/search`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "blocked display", cpcPrefixes: ["G09G3", "G09G5"] }) });
  s = await r.json();
  check("search: Google blocked + no Apify key → 502 with hint", r.status === 502 && /Apify token/.test(s.error), `${r.status} ${s.error}`);
  const gq = (await (await fetch(`${MOCK}/__log`)).json()).filter((e) => e.path === "/xhr/query").pop();
  check("search: Google query carries CPC filters", decodeURIComponent(gq.query.url).includes("(CPC=G09G3 OR CPC=G09G5)"), decodeURIComponent(gq.query.url));

  r = await fetch(`${APP}/api/patent-ledger/search`, { method: "POST", headers: hdrNoPv(), body: JSON.stringify({ query: "blocked display", dateFrom: "2018-01-01" }) });
  s = await r.json();
  check("search: Google blocked → Apify actor, non-US and out-of-range dropped", r.status === 200 && s.source === "google-patents-apify" && s.patents.length === 1 && s.inventors.length === 2 && s.warnings.some((w) => /Apify/.test(w)), `${r.status} ${s.source || s.error} ${s.patents?.length}`);
  r = await fetch(`${APP}/api/patent-ledger/search`, { method: "POST", headers: hdrNoPv(), body: JSON.stringify({ query: "blocked display", assignee: "Facebook" }) });
  s = await r.json();
  check("search: Apify company filter matches legal entity by brand (Facebook → Meta Platforms Technologies)", r.status === 200 && s.patents.length === 2 && s.patents.every((p) => /Meta Platforms/.test(p.assignees[0])), `${r.status} ${s.patents?.map((p) => p.id).join(",") || s.error}`);
  const actorCall = (await (await fetch(`${MOCK}/__log`)).json()).filter((e) => /fetch_cat~google-patents-search-scraper/.test(e.path)).pop();
  check("search: Apify patent actor uses proxy", JSON.parse(actorCall.body).proxyConfiguration?.useApifyProxy === true, actorCall.body);

  r = await fetch(`${APP}/api/patent-ledger/status`, { headers: { "x-ledger-keys": JSON.stringify({ apify: "apify-test-token" }) } });
  s = await r.json();
  check("status: browser key adds to server keys, values never returned", s.providers.apify === true && s.providers.pdl === true && !JSON.stringify(s).includes("test-"), JSON.stringify(s));

  /* ── API: bad PatentsView key surfaces clearly when forced ── */
  r = await fetch(`${APP}/api/patent-ledger/search`, { method: "POST", headers: { "Content-Type": "application/json", "x-ledger-keys": JSON.stringify({ patentsview: "wrong" }) }, body: JSON.stringify({ query: "vr", source: "patentsview" }) });
  s = await r.json();
  check("search: wrong key, source=patentsview → 502 with 403 message", r.status === 502 && /403/.test(s.error), s.error);

  /* ── API: enrich, provider chain ── */
  const enrich = (inv, extra = {}, headers = hdr) =>
    fetch(`${APP}/api/patent-ledger/enrich`, { method: "POST", headers, body: JSON.stringify({ inventor: inv, ...extra }) }).then(async (x) => [x.status, await x.json()]);

  let [st, e] = await enrich({ firstName: "Maria", lastName: "Vance", city: "Redmond", state: "WA", country: "US", assignee: "Meta Platforms Technologies, LLC" });
  check("enrich: PDL hit wins, Apollo/Apify not called", st === 200 && e.best?.provider === "pdl" && e.attempts.length === 1, JSON.stringify(e.attempts));
  check("enrich: PDL URL normalised + score high", e.best?.linkedinUrl === "https://www.linkedin.com/in/maria-vance-display" && e.best.score >= 80, `${e.best?.linkedinUrl} ${e.best?.score} ${e.best?.reasons?.join("|")}`);
  const pdlCall = (await (await fetch(`${MOCK}/__log`)).json()).find((x) => x.path === "/v5/person/enrich");
  check("enrich: PDL params include required=linkedin_url & min_likelihood", pdlCall.query.required === "linkedin_url" && pdlCall.query.min_likelihood === "6" && pdlCall.query.company?.startsWith("Meta"), JSON.stringify(pdlCall.query));

  [st, e] = await enrich({ firstName: "Dele", lastName: "Okafor", city: "Seattle", state: "WA", assignee: "Meta Platforms Technologies, LLC" });
  check("enrich: PDL miss → Apollo hit", st === 200 && e.best?.provider === "apollo" && e.attempts.map((a) => a.status).join(",") === "no_match,match", JSON.stringify(e.attempts));
  check("enrich: Apollo URL normalised", e.best?.linkedinUrl === "https://www.linkedin.com/in/dele-okafor", e.best?.linkedinUrl);

  [st, e] = await enrich({ firstName: "Priya", lastName: "Shah", city: "Sunnyvale", state: "CA", assignee: "Meta Platforms Technologies, LLC" });
  check("enrich: PDL+Apollo miss → Apify google search", st === 200 && e.best?.provider === "apify" && e.attempts.length === 3, JSON.stringify(e.attempts));
  check("enrich: Apify candidates ranked, company page + other first name dropped, Meta engineer first", e.candidates.length === 2 && e.best.linkedinUrl === "https://www.linkedin.com/in/priya-shah-gfx" && e.best.score > e.candidates[1].score, e.candidates.map((c) => `${c.score}:${c.linkedinUrl}`).join(" "));
  check("enrich: Apify duplicate profile merged across queries", e.candidates.filter((c) => c.linkedinUrl === "https://www.linkedin.com/in/priya-shah-gfx").length === 1 && e.best.reasons.includes("company: match"), JSON.stringify(e.best));
  let apifyCalls = (await (await fetch(`${MOCK}/__log`)).json()).filter((x) => /run-sync-get-dataset-items/.test(x.path) && /Priya Shah/.test(x.body));
  check("enrich: Apify actor + query shape (brand name, then name only, one run)", apifyCalls.length === 1 && apifyCalls[0].path.includes("apify~google-search-scraper") && JSON.parse(apifyCalls[0].body).queries === 'site:linkedin.com/in "Priya Shah" Meta\nsite:linkedin.com/in "Priya Shah"', apifyCalls.map((c) => c.body).join(" | "));

  [st, e] = await enrich({ firstName: "Ravi", lastName: "Drop", assignee: "Waymo LLC" });
  apifyCalls = (await (await fetch(`${MOCK}/__log`)).json()).filter((x) => /run-sync-get-dataset-items/.test(x.path));
  check("enrich: Apify re-runs a query whose page was dropped", e.best?.linkedinUrl === "https://www.linkedin.com/in/ravi-drop" && JSON.parse(apifyCalls[apifyCalls.length - 1].body).queries === 'site:linkedin.com/in "Ravi Drop"', apifyCalls.slice(-2).map((c) => c.body).join(" | "));

  [st, e] = await enrich({ firstName: "Nobody", lastName: "Nomatch" });
  check("enrich: all miss → 200, no best, 3 attempts", st === 200 && !e.best && e.attempts.length === 3, JSON.stringify(e.attempts));

  [st, e] = await enrich({ firstName: "Maria", lastName: "Vance" }, {}, { "Content-Type": "application/json" });
  check("enrich: signed in, no browser keys → server PDL key used", st === 200 && e.best?.provider === "pdl", JSON.stringify(e.attempts));

  r = await rawFetch(`${APP}/api/patent-ledger/enrich`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inventor: { firstName: "Maria", lastName: "Vance" } }) });
  check("enrich: signed out → 401, server keys unused", r.status === 401);

  /* ── Browser: real page flow ── */
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  // Signed out: the tool redirects to the login page; signing in there returns to the tool.
  await page.goto(`${APP}/tools/patent-ledger`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector('input[autocomplete="username"]', { timeout: 60000 });
  check("ui: signed-out visit lands on the login page", page.url().includes("/login?next="), page.url());
  await page.type('input[autocomplete="username"]', "tester");
  await page.type('input[autocomplete="current-password"]', "correct horse");
  await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }), page.click('button[type="submit"]')]);
  await page.waitForSelector('main[data-hydrated="1"]', { timeout: 60000 });
  check("ui: login returns to the tool", page.url().endsWith("/tools/patent-ledger"), page.url());
  await page.waitForFunction(() => document.body.innerText.includes("Signed in as"), { timeout: 15000 }).catch(() => {});
  check("ui: header shows signed-in user and Sign out", await page.evaluate(() => document.body.innerText.includes("tester") && [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Sign out")));
  check("ui: page renders", (await page.title()).includes("Patent"), await page.title());
  const robots = await page.$eval('meta[name="robots"]', (m) => m.content).catch(() => "");
  check("ui: noindex meta present", /noindex/.test(robots), robots);

  // Put keys in localStorage (what the Settings panel does), reload.
  await page.evaluate((k) => {
    localStorage.setItem("patent-ledger:settings:v1", JSON.stringify({ keys: k, providers: ["pdl", "apollo", "apify"], minLikelihood: 6, apifyActorId: "apify~google-search-scraper", apifyInput: "" }));
  }, KEYS);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector('main[data-hydrated="1"]', { timeout: 60000 });

  // Click by exact label from inside the page so overlays (cookie banner, exit popup) cannot intercept.
  const clickButton = async (text) => {
    const found = await page.evaluate((t) => {
      const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === t);
      if (b) b.click();
      return !!b;
    }, text);
    if (!found) throw new Error(`button "${text}" not found`);
  };
  await clickButton("Search patents");
  await page.waitForFunction(() => document.body.innerText.includes("Maria Vance"), { timeout: 20000 });
  const inventorCount = await page.evaluate(() => document.querySelectorAll("tbody tr").length);
  check("ui: search renders 3 inventor rows", inventorCount === 3, String(inventorCount));

  // The header pills and Run button come alive once /status confirms the browser keys.
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Run" && !b.disabled), { timeout: 15000 });
  const pills = await page.evaluate(() => [...document.querySelectorAll("header [title]")].map((e) => e.getAttribute("title")));
  check("ui: header shows PDL and Apify connected", pills.includes("PDL: connected") && pills.includes("Apify: connected"), pills.join(" | "));

  // Enrich all three via the bulk button (confirm dialog auto-accepted).
  page.on("dialog", (d) => d.accept());
  await clickButton("Run");
  const linkFor = (slug) => `a[href="https://www.linkedin.com/in/${slug}"]`;
  await page.waitForSelector(linkFor("priya-shah-gfx"), { timeout: 30000 });
  const text = await page.evaluate(() => document.body.innerText);
  const has = async (slug) => !!(await page.$(linkFor(slug)));
  check("ui: PDL match shown", (await has("maria-vance-display")) && text.includes("via pdl"));
  check("ui: Apollo match shown", (await has("dele-okafor")) && text.includes("via apollo"));
  check("ui: Apify match shown", (await has("priya-shah-gfx")) && text.includes("via apify"));

  // Save first match, then open the ledger tab and export CSV.
  const saved = await page.evaluate(() => {
    const bs = [...document.querySelectorAll("button")].filter((x) => x.textContent.trim() === "Save to ledger");
    bs.forEach((b) => b.click());
    return bs.length;
  });
  await sleep(300);
  check("ui: three Save buttons clicked", saved === 3, String(saved));
  const ledgerRaw = await page.evaluate(() => localStorage.getItem("patent-ledger:ledger:v1"));
  const ledger = JSON.parse(ledgerRaw || "[]");
  check("ui: ledger persisted to localStorage with patents attached", ledger.length === 3 && ledger.every((r) => r.linkedinUrl && r.patentIds.length >= 1), `${ledger.length} rows`);
  await page.click('[data-tab="ledger"]');
  await page.waitForFunction(() => document.body.innerText.includes("Export CSV"));
  check("ui: ledger tab lists the three saved rows", (await page.evaluate(() => document.querySelectorAll("tbody tr").length)) === 3);
  await page.screenshot({ path: join(tmpdir(), "patent-ledger-smoke.png"), fullPage: true });
  check("ui: no page errors", pageErrors.length === 0, pageErrors.join(" | "));
  await browser.close();
} catch (err) {
  console.error("SMOKE CRASH:", err);
  failures++;
} finally {
  for (const p of procs) {
    try { process.kill(-p.pid, "SIGTERM"); } catch { p.kill("SIGTERM"); }
  }
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
