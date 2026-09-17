"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Candidate,
  EnrichProvider,
  EnrichResponse,
  Inventor,
  LedgerKeys,
  Patent,
  SearchRequest,
  SearchResponse,
} from "@/lib/patent-ledger/types";
import { employerFromAssignee } from "@/lib/patent-ledger/company";

/* ───────────────────────── constants ───────────────────────── */

const SETTINGS_KEY = "patent-ledger:settings:v1";
const LEDGER_KEY = "patent-ledger:ledger:v1";

interface Settings {
  keys: LedgerKeys;
  providers: EnrichProvider[];
  minLikelihood: number;
  apifyActorId: string;
  apifyInput: string; // JSON text, empty = default google-search template
}

const DEFAULT_SETTINGS: Settings = {
  keys: {},
  providers: ["pdl", "apollo", "apify"],
  minLikelihood: 6,
  apifyActorId: "apify~google-search-scraper",
  apifyInput: "",
};

const PROVIDER_LABEL: Record<EnrichProvider, string> = { pdl: "People Data Labs", apollo: "Apollo", apify: "Apify" };

/** Electrical-engineering CPC presets, sent to Google Patents as CPC= filters. */
const CPC_PRESETS: { label: string; codes: string[] }[] = [
  { label: "VR / AR headsets", codes: ["G02B27/01"] },
  { label: "Display driving", codes: ["G09G3", "G09G5"] },
  { label: "Stereoscopic 3D", codes: ["H04N13"] },
  { label: "OLED", codes: ["H10K59", "H10K50"] },
  { label: "LCD", codes: ["G02F1/13"] },
  { label: "LED / micro-LED", codes: ["H01L33", "H10H20"] },
  { label: "Optics & waveguides", codes: ["G02B6", "G02B27/00"] },
  { label: "Eye tracking & gesture", codes: ["G06F3/01"] },
  { label: "Image sensors", codes: ["H04N25", "H01L27/146"] },
  { label: "Semiconductors", codes: ["H01L"] },
  { label: "Antennas", codes: ["H01Q"] },
  { label: "RF", codes: ["H03F", "H04B1"] },
  { label: "Power conversion", codes: ["H02M"] },
  { label: "Batteries", codes: ["H01M10"] },
  { label: "Neural-net hardware", codes: ["G06N3"] },
];

const SOURCE_LABEL: Record<string, string> = {
  uspto: "USPTO",
  patentsview: "PatentsView",
  "google-patents": "Google Patents",
  "google-patents-apify": "Google Patents via Apify",
};

interface LedgerRow {
  id: string;
  savedAt: string;
  inventor: string;
  inventorId?: string;
  location: string;
  assignee: string;
  linkedinUrl: string;
  score: number;
  provider: string;
  title: string;
  company: string;
  patentIds: string[];
  patentTitles: string[];
  query: string;
  notes: string;
}

interface EnrichState {
  status: "idle" | "loading" | "done" | "error";
  result?: EnrichResponse;
  error?: string;
  chosen?: number; // index into candidates
}

interface ServerStatus {
  user: string | null;
  providers: { pdl: boolean; apollo: boolean; apify: boolean; patentsview: boolean };
}

/* ───────────────────────── storage helpers ───────────────────────── */

function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(fallback)) return (Array.isArray(parsed) ? parsed : fallback) as T;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { ...fallback, ...(parsed as T) };
    return fallback;
  } catch {
    return fallback;
  }
}
function saveJSON(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: settings live for the session only */
  }
}

function csvEscape(v: unknown): string {
  const s = Array.isArray(v) ? v.join("; ") : String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function download(name: string, mime: string, text: string) {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ───────────────────────── shared styles ───────────────────────── */

/** Unsized control; add a width. `input` is the full-width form field. */
const control =
  "rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:font-sans placeholder:text-faint transition-colors hover:border-line-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15";
const input = `${control} w-full`;
const labelText = "mb-1 block text-xs font-medium text-muted";
const btnPrimary =
  "inline-flex items-center justify-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40";
const btnSecondary =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink transition-colors hover:border-line-strong hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-40";
const btnGhost = "text-xs font-medium text-muted underline-offset-2 hover:text-ink hover:underline";

/* ───────────────────────── component ───────────────────────── */

export default function PatentLedgerClient() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [server, setServer] = useState<ServerStatus | null>(null);

  // search form
  const [query, setQuery] = useState("high resolution display virtual reality");
  const [mode, setMode] = useState<"all" | "any">("all");
  const [presets, setPresets] = useState<string[]>([]);
  const [customCpc, setCustomCpc] = useState("");
  const [assignee, setAssignee] = useState("");
  const [dateFrom, setDateFrom] = useState("2018-01-01");
  const [dateTo, setDateTo] = useState("");
  const [size, setSize] = useState(25);
  const [source, setSource] = useState<"auto" | "uspto" | "google-patents" | "google-patents-apify">("auto");

  // results
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [tab, setTab] = useState<"inventors" | "patents" | "ledger">("inventors");
  const [enrich, setEnrich] = useState<Record<string, EnrichState>>({});
  const [bulkCount, setBulkCount] = useState(10);
  const [bulkRunning, setBulkRunning] = useState(false);
  const bulkAbort = useRef(false);
  const [inventorFilter, setInventorFilter] = useState("");

  useEffect(() => {
    setSettings(loadJSON(SETTINGS_KEY, DEFAULT_SETTINGS));
    setLedger(loadJSON<LedgerRow[]>(LEDGER_KEY, []));
    setHydrated(true);
  }, []);
  useEffect(() => {
    if (hydrated) saveJSON(SETTINGS_KEY, settings);
  }, [settings, hydrated]);
  useEffect(() => {
    if (hydrated) saveJSON(LEDGER_KEY, ledger);
  }, [ledger, hydrated]);

  const headers = useMemo(() => {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    const keys = Object.fromEntries(Object.entries(settings.keys).filter(([, v]) => v && v.trim()));
    if (Object.keys(keys).length) h["x-ledger-keys"] = JSON.stringify(keys);
    return h;
  }, [settings.keys]);

  // Ask the server which providers are usable (browser keys + server keys). Booleans only.
  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    const t = setTimeout(() => {
      fetch("/api/patent-ledger/status", { headers })
        .then((r) => (r.ok ? (r.json() as Promise<ServerStatus>) : null))
        .then((s) => !cancelled && setServer(s))
        .catch(() => !cancelled && setServer(null));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [headers, hydrated]);

  const available = server?.providers ?? { pdl: false, apollo: false, apify: false, patentsview: false };
  const hasEnrichKey = available.pdl || available.apollo || available.apify;

  const cpcPrefixes = useMemo(() => {
    const fromPresets = CPC_PRESETS.filter((p) => presets.includes(p.label)).flatMap((p) => p.codes);
    const custom = customCpc.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    return [...new Set([...fromPresets, ...custom])];
  }, [presets, customCpc]);

  const patentsById = useMemo(() => {
    const m = new Map<string, Patent>();
    result?.patents.forEach((p) => m.set(p.id, p));
    return m;
  }, [result]);

  const ledgerUrls = useMemo(() => new Set(ledger.map((r) => r.linkedinUrl)), [ledger]);

  /* ── search ── */
  const runSearch = useCallback(async () => {
    setSearching(true);
    setSearchError(null);
    setEnrich({});
    bulkAbort.current = true;
    const body: SearchRequest = {
      query,
      mode,
      cpcPrefixes,
      assignee: assignee || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      size,
      source,
    };
    try {
      const res = await fetch("/api/patent-ledger/search", { method: "POST", headers, body: JSON.stringify(body) });
      const data = (await res.json()) as SearchResponse & { error?: string };
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      setResult(data);
      setTab("inventors");
    } catch (err) {
      setResult(null);
      setSearchError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  }, [query, mode, cpcPrefixes, assignee, dateFrom, dateTo, size, source, headers]);

  /* ── enrich one ── */
  const enrichOne = useCallback(
    async (inv: Inventor) => {
      setEnrich((s) => ({ ...s, [inv.key]: { status: "loading" } }));
      let apifyInput: Record<string, unknown> | undefined;
      if (settings.apifyInput.trim()) {
        try {
          apifyInput = JSON.parse(settings.apifyInput) as Record<string, unknown>;
        } catch {
          setEnrich((s) => ({ ...s, [inv.key]: { status: "error", error: "Apify input template is not valid JSON." } }));
          return;
        }
      }
      try {
        const res = await fetch("/api/patent-ledger/enrich", {
          method: "POST",
          headers,
          body: JSON.stringify({
            inventor: {
              firstName: inv.firstName,
              lastName: inv.lastName,
              fullName: inv.fullName,
              city: inv.city,
              state: inv.state,
              country: inv.country,
              assignee: inv.assignee,
            },
            providers: settings.providers,
            minLikelihood: settings.minLikelihood,
            apify: { actorId: settings.apifyActorId || undefined, input: apifyInput },
          }),
        });
        const data = (await res.json()) as EnrichResponse & { error?: string };
        if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
        setEnrich((s) => ({ ...s, [inv.key]: { status: "done", result: data, chosen: 0 } }));
      } catch (err) {
        setEnrich((s) => ({ ...s, [inv.key]: { status: "error", error: err instanceof Error ? err.message : String(err) } }));
      }
    },
    [headers, settings],
  );

  const visibleInventors = useMemo(() => {
    const list = result?.inventors ?? [];
    const f = inventorFilter.trim().toLowerCase();
    if (!f) return list;
    return list.filter(
      (i) =>
        i.fullName.toLowerCase().includes(f) ||
        (i.assignee || "").toLowerCase().includes(f) ||
        `${i.city || ""} ${i.state || ""}`.toLowerCase().includes(f),
    );
  }, [result, inventorFilter]);

  const hasLocations = useMemo(() => (result?.inventors ?? []).some((i) => i.city || i.state), [result]);

  /* ── enrich many, sequentially (light) ── */
  const enrichBulk = useCallback(async () => {
    const targets = visibleInventors.filter((i) => !enrich[i.key] || enrich[i.key].status === "error").slice(0, bulkCount);
    if (!targets.length) return;
    if (!window.confirm(`Look up LinkedIn for ${targets.length} inventor(s)? Each lookup can spend a credit with the first provider that matches.`)) return;
    bulkAbort.current = false;
    setBulkRunning(true);
    for (const inv of targets) {
      if (bulkAbort.current) break;
      await enrichOne(inv);
    }
    setBulkRunning(false);
  }, [visibleInventors, enrich, bulkCount, enrichOne]);

  /* ── ledger ── */
  const saveToLedger = useCallback(
    (inv: Inventor, c: Candidate) => {
      if (!c.linkedinUrl) return;
      const row: LedgerRow = {
        id: `${inv.key}|${c.linkedinUrl}`,
        savedAt: new Date().toISOString(),
        inventor: inv.fullName,
        inventorId: inv.inventorId,
        location: [inv.city, inv.state, inv.country].filter(Boolean).join(", "),
        assignee: inv.assignee || "",
        linkedinUrl: c.linkedinUrl,
        score: c.score,
        provider: c.provider,
        title: c.title || "",
        company: c.company || "",
        patentIds: inv.patentIds,
        patentTitles: inv.patentIds.map((id) => patentsById.get(id)?.title || id),
        query: [query, assignee, cpcPrefixes.join(" ")].filter(Boolean).join(" · "),
        notes: "",
      };
      setLedger((l) => [row, ...l.filter((r) => r.id !== row.id)]);
    },
    [patentsById, query, assignee, cpcPrefixes],
  );

  const exportCsv = () => {
    const cols: (keyof LedgerRow)[] = [
      "inventor", "linkedinUrl", "score", "provider", "title", "company", "assignee", "location",
      "patentIds", "patentTitles", "inventorId", "query", "notes", "savedAt",
    ];
    const lines = [cols.join(","), ...ledger.map((r) => cols.map((c) => csvEscape(r[c])).join(","))];
    download(`patent-linkedin-ledger-${new Date().toISOString().slice(0, 10)}.csv`, "text/csv", lines.join("\n"));
  };
  const exportJson = () => download("patent-linkedin-ledger.json", "application/json", JSON.stringify(ledger, null, 2));
  const importJson = (file: File) => {
    file.text().then((t) => {
      try {
        const rows = JSON.parse(t) as LedgerRow[];
        if (!Array.isArray(rows)) throw new Error("not an array");
        setLedger((l) => {
          const ids = new Set(l.map((r) => r.id));
          return [...l, ...rows.filter((r) => r && r.id && !ids.has(r.id))];
        });
      } catch {
        window.alert("Could not import: expected a JSON array exported from this tool.");
      }
    });
  };

  const matched = Object.values(enrich).filter((e) => e.status === "done" && e.result?.candidates.length).length;
  const strong = Object.values(enrich).filter((e) => e.status === "done" && (e.result?.candidates[e.chosen ?? 0]?.score ?? 0) >= 70).length;

  /* ───────────────────────── render ───────────────────────── */

  return (
    <main className="min-h-screen" data-hydrated={hydrated ? "1" : "0"}>
      {/* ── top bar ── */}
      <header className="sticky top-0 z-20 border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3">
            <span className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-accent">Inventor research</span>
            <h1 className="text-base font-semibold tracking-tight text-ink">Patent → LinkedIn Ledger</h1>
          </div>
          <div className="order-3 flex w-full flex-wrap items-center gap-1.5 sm:order-2 sm:w-auto">
            <StatusPill label="Patents" value={result?.source === "google-patents-apify" ? "via Apify" : result?.source === "google-patents" ? "Google" : "USPTO"} ok />
            <StatusPill label="PDL" ok={available.pdl} loading={!server && hydrated} />
            <StatusPill label="Apify" ok={available.apify} loading={!server && hydrated} />
            <StatusPill label="Apollo" ok={available.apollo} loading={!server && hydrated} />
          </div>
          <div className="order-2 flex items-center gap-2 sm:order-3">
            {server?.user && (
              <span className="hidden text-xs text-muted sm:inline">
                Signed in as <span className="font-medium text-ink">{server.user}</span>
              </span>
            )}
            <button type="button" onClick={() => setShowSettings(true)} className={btnSecondary}>
              <GearIcon />
              Settings
            </button>
            {server?.user && (
              <button
                type="button"
                onClick={() => void fetch("/api/auth/logout", { method: "POST" }).then(() => window.location.assign("/login"))}
                className={btnSecondary}
              >
                Sign out
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {hydrated && server && !hasEnrichKey && (
          <Notice tone="warn">
            No LinkedIn lookup keys are available. Add a People Data Labs or Apify key in Settings, or put them in
            <code className="mx-1 font-mono text-xs">.env.local</code>and restart.
          </Notice>
        )}

        {/* ── search ── */}
        <section className="rounded-xl border border-line bg-surface p-4 shadow-[0_1px_2px_rgba(20,23,28,0.04)] sm:p-5">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void runSearch();
            }}
            className="grid gap-4"
          >
            <div>
              <label htmlFor="q" className={labelText}>
                Keywords in patent title and abstract
              </label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <div className="relative flex-1">
                  <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
                  <input
                    id="q"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="e.g. solid state battery electrolyte"
                    className={`${input} h-11 pl-9 text-[15px]`}
                  />
                </div>
                <Segmented
                  value={mode}
                  onChange={setMode}
                  options={[
                    { value: "all", label: "All words" },
                    { value: "any", label: "Any word" },
                  ]}
                />
                <button type="submit" disabled={searching} className={`${btnPrimary} h-11 px-5`}>
                  {searching ? "Searching…" : "Search patents"}
                </button>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr]">
              <label className="block">
                <span className={labelText}>Company or domain</span>
                <input value={assignee} onChange={(e) => setAssignee(e.target.value)} placeholder="meta.com, General Motors, Magic Leap" className={input} />
              </label>
              <label className="block">
                <span className={labelText}>Filed from</span>
                <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className={input} />
              </label>
              <label className="block">
                <span className={labelText}>Filed to</span>
                <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className={input} />
              </label>
              <label className="block">
                <span className={labelText}>Max patents</span>
                <select value={size} onChange={(e) => setSize(Number(e.target.value))} className={input}>
                  {[
                    [25, "25 · about 25 seconds"],
                    [50, "50 · about 1 minute"],
                    [100, "100 · about 2 minutes"],
                  ].map(([n, label]) => (
                    <option key={n} value={n}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div>
              <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
                <span className={labelText}>Technology class (optional, CPC)</span>
                {cpcPrefixes.length > 0 && (
                  <span className="font-mono text-[11px] text-muted">
                    {cpcPrefixes.join(" · ")}
                    <button type="button" onClick={() => { setPresets([]); setCustomCpc(""); }} className={`${btnGhost} ml-2`}>
                      clear
                    </button>
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {CPC_PRESETS.map((p) => {
                  const on = presets.includes(p.label);
                  return (
                    <button
                      type="button"
                      key={p.label}
                      onClick={() => setPresets((s) => (on ? s.filter((x) => x !== p.label) : [...s, p.label]))}
                      className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                        on ? "border-accent bg-accent-soft font-medium text-accent-strong" : "border-line bg-surface text-muted hover:border-line-strong hover:text-ink"
                      }`}
                      title={p.codes.join(", ")}
                      aria-pressed={on}
                    >
                      {p.label}
                    </button>
                  );
                })}
                <input
                  value={customCpc}
                  onChange={(e) => setCustomCpc(e.target.value)}
                  placeholder="+ custom codes"
                  aria-label="Custom CPC codes, comma-separated"
                  className="w-36 rounded-full border border-dashed border-line bg-transparent px-2.5 py-1 font-mono text-xs text-ink placeholder:font-sans placeholder:text-faint focus:border-accent focus:outline-none"
                />
              </div>
            </div>
          </form>
          {searching && (
            <div className="mt-3 flex items-center gap-2 text-xs text-muted">
              <Spinner /> Loading full inventor records from the USPTO. It allows about one record every two seconds after the first twenty, so larger searches take longer.
            </div>
          )}
          {searchError && <Notice tone="error">{searchError}</Notice>}
        </section>

        {/* ── results header + tabs ── */}
        <div className="mt-6 flex flex-wrap items-end justify-between gap-3 border-b border-line">
          <nav className="flex gap-1" role="tablist">
            {(["inventors", "patents", "ledger"] as const).map((t) => {
              const count = t === "inventors" ? result?.inventors.length : t === "patents" ? result?.patents.length : ledger.length;
              const active = tab === t;
              return (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-tab={t}
                  onClick={() => setTab(t)}
                  className={`-mb-px flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium capitalize transition-colors ${
                    active ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink"
                  }`}
                >
                  {t}
                  {count !== undefined && (
                    <span className={`tabular rounded-full px-1.5 py-px font-mono text-[11px] ${active ? "bg-accent-soft text-accent-strong" : "bg-check-soft text-muted"}`}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
          {result && tab !== "ledger" && (
            <div className="tabular pb-2.5 text-xs text-muted">
              {result.patents.length} patents · {result.inventors.length} inventors · {SOURCE_LABEL[result.source] || result.source}
              {Object.keys(enrich).length > 0 && (
                <>
                  {" "}· {matched} with a candidate · <span className="font-medium text-strong">{strong} strong</span>
                </>
              )}
            </div>
          )}
        </div>
        {result && tab !== "ledger" && result.warnings.map((w, i) => <Notice key={i} tone="info">{w}</Notice>)}

        {/* ── inventors ── */}
        {tab === "inventors" && (
          <section className="mt-4">
            {!result && <EmptyState title="No search yet" body="Enter keywords above and search. Inventors from the matching patents show up here." />}
            {result && (
              <>
                <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2.5">
                  <div className="relative w-full sm:w-72">
                    <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
                    <input
                      value={inventorFilter}
                      onChange={(e) => setInventorFilter(e.target.value)}
                      placeholder="Filter by name or company"
                      className={`${input} py-1.5 pl-8`}
                    />
                  </div>
                  <div className="ml-auto flex flex-wrap items-center gap-2 text-sm text-muted">
                    <span>Find LinkedIn for the first</span>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={bulkCount}
                      onChange={(e) => setBulkCount(Math.max(1, Number(e.target.value) || 1))}
                      className={`${control} tabular w-16 px-2 py-1.5 text-center`}
                      aria-label="Number of inventors to look up"
                    />
                    <span>inventors</span>
                    {bulkRunning ? (
                      <button type="button" onClick={() => (bulkAbort.current = true)} className={`${btnSecondary} border-danger/40 text-danger`}>
                        Stop
                      </button>
                    ) : (
                      <button type="button" disabled={!hasEnrichKey} onClick={() => void enrichBulk()} className={`${btnPrimary} py-1.5`}>
                        Run
                      </button>
                    )}
                  </div>
                </div>

                <div className="overflow-x-auto rounded-lg border border-line bg-surface">
                  <table className="w-full min-w-[760px] text-left text-sm">
                    <thead className="border-b border-line bg-sunken text-[11px] font-medium uppercase tracking-wider text-muted">
                      <tr>
                        <th className="px-4 py-2.5">Inventor</th>
                        {hasLocations && <th className="px-4 py-2.5">Location</th>}
                        <th className="px-4 py-2.5">Patents</th>
                        <th className="w-[46%] px-4 py-2.5">LinkedIn</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {visibleInventors.map((inv) => (
                        <InventorRow
                          key={inv.key}
                          inv={inv}
                          state={enrich[inv.key]}
                          patentsById={patentsById}
                          canEnrich={hasEnrichKey}
                          showLocation={hasLocations}
                          inLedger={ledgerUrls}
                          onEnrich={() => void enrichOne(inv)}
                          onChoose={(i) => setEnrich((s) => ({ ...s, [inv.key]: { ...s[inv.key], chosen: i } }))}
                          onSave={(c) => saveToLedger(inv, c)}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        )}

        {/* ── patents ── */}
        {tab === "patents" && (
          <section className="mt-4 grid gap-2.5">
            {!result && <EmptyState title="No search yet" body="Patents from your search show up here." />}
            {result?.patents.map((p) => (
              <article key={p.id} className="rounded-lg border border-line bg-surface p-4 transition-colors hover:border-line-strong">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <a href={p.url} target="_blank" rel="noreferrer" className="font-medium text-ink hover:text-accent hover:underline">
                    {p.title}
                  </a>
                  <span className="tabular font-mono text-[11px] text-muted">
                    {p.id} · {p.date || "?"}
                  </span>
                </div>
                <div className="mt-1 text-xs text-muted">
                  {p.assignees.length > 0 && <span className="font-medium text-ink/80">{p.assignees.join("; ")}</span>}
                  {p.assignees.length > 0 && " · "}
                  {p.inventors.map((i) => `${i.firstName} ${i.lastName}`.trim()).join(", ") || "Inventors unknown"}
                  {p.cpc.length > 0 && <span className="font-mono"> · {p.cpc.slice(0, 5).join(", ")}</span>}
                </div>
                {p.abstract && <p className="mt-2 line-clamp-2 text-sm text-muted">{p.abstract}</p>}
              </article>
            ))}
          </section>
        )}

        {/* ── ledger ── */}
        {tab === "ledger" && (
          <section className="mt-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <button type="button" onClick={exportCsv} disabled={!ledger.length} className={btnSecondary}>
                Export CSV
              </button>
              <button type="button" onClick={exportJson} disabled={!ledger.length} className={btnSecondary}>
                Export JSON
              </button>
              <label className={`${btnSecondary} cursor-pointer`}>
                Import JSON
                <input type="file" accept="application/json" className="hidden" onChange={(e) => e.target.files?.[0] && importJson(e.target.files[0])} />
              </label>
              <span className="text-xs text-faint">Saved in this browser. Export regularly; import merges by row.</span>
              <button
                type="button"
                onClick={() => window.confirm("Clear the whole ledger from this browser?") && setLedger([])}
                disabled={!ledger.length}
                className={`${btnSecondary} ml-auto text-danger hover:border-danger/40`}
              >
                Clear
              </button>
            </div>
            {!ledger.length && <EmptyState title="Nothing saved yet" body="Find a LinkedIn match on the Inventors tab and click Save to ledger." />}
            {ledger.length > 0 && (
              <div className="overflow-x-auto rounded-lg border border-line bg-surface">
                <table className="w-full min-w-[900px] text-left text-sm">
                  <thead className="border-b border-line bg-sunken text-[11px] font-medium uppercase tracking-wider text-muted">
                    <tr>
                      <th className="px-4 py-2.5">Inventor</th>
                      <th className="px-4 py-2.5">LinkedIn</th>
                      <th className="px-4 py-2.5">Match</th>
                      <th className="px-4 py-2.5">Current role</th>
                      <th className="px-4 py-2.5">Patents</th>
                      <th className="px-4 py-2.5">Notes</th>
                      <th className="px-4 py-2.5"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {ledger.map((r) => (
                      <tr key={r.id} className="align-top hover:bg-sunken/60">
                        <td className="px-4 py-3">
                          <div className="font-medium">{r.inventor}</div>
                          <div className="text-xs text-muted">{r.assignee}</div>
                        </td>
                        <td className="px-4 py-3">
                          <a href={r.linkedinUrl} target="_blank" rel="noreferrer" className="font-mono text-xs text-accent hover:underline">
                            {r.linkedinUrl.replace("https://www.linkedin.com", "")}
                          </a>
                          <div className="text-xs text-faint">via {r.provider}</div>
                        </td>
                        <td className="px-4 py-3">
                          <ScoreBadge score={r.score} />
                        </td>
                        <td className="px-4 py-3 text-xs text-muted">{[r.title, r.company].filter(Boolean).join(" @ ") || "—"}</td>
                        <td className="tabular px-4 py-3 font-mono text-xs text-muted" title={r.patentTitles.join("\n")}>
                          {r.patentIds.length} · {r.patentIds.slice(0, 2).join(", ")}
                          {r.patentIds.length > 2 ? "…" : ""}
                        </td>
                        <td className="px-4 py-3">
                          <input
                            value={r.notes}
                            onChange={(e) => setLedger((l) => l.map((x) => (x.id === r.id ? { ...x, notes: e.target.value } : x)))}
                            className={`${control} w-40 px-2 py-1 text-xs`}
                            placeholder="Add a note"
                          />
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button type="button" onClick={() => setLedger((l) => l.filter((x) => x.id !== r.id))} className={`${btnGhost} hover:text-danger`}>
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </div>

      {/* ── settings drawer ── */}
      {showSettings && (
        <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label="Settings">
          <button type="button" aria-label="Close settings" className="absolute inset-0 bg-ink/25" onClick={() => setShowSettings(false)} />
          <aside className="relative flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-line bg-surface shadow-2xl">
            <div className="sticky top-0 flex items-center justify-between border-b border-line bg-surface px-5 py-4">
              <h2 className="text-base font-semibold">Settings</h2>
              <button type="button" onClick={() => setShowSettings(false)} className={btnSecondary}>
                Close settings
              </button>
            </div>
            <div className="grid gap-6 px-5 py-5">
              <section>
                <h3 className="mb-2 text-sm font-semibold">Connected</h3>
                <div className="grid gap-1.5 rounded-lg border border-line bg-sunken p-3 text-sm">
                  {(["pdl", "apify", "apollo"] as EnrichProvider[]).map((p) => (
                    <div key={p} className="flex items-center justify-between">
                      <span>{PROVIDER_LABEL[p]}</span>
                      <span className={`flex items-center gap-1.5 text-xs ${available[p] ? "text-strong" : "text-faint"}`}>
                        <Dot ok={available[p]} />
                        {available[p] ? (settings.keys[p] ? "browser key" : "server key") : "no key"}
                      </span>
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-xs text-muted">
                  Server keys come from <code className="font-mono">.env.local</code> and never reach the browser. Keys typed below
                  override them for this browser only.
                </p>
              </section>

              <section>
                <h3 className="mb-2 text-sm font-semibold">Lookup order</h3>
                <div className="grid gap-1.5">
                  {(["pdl", "apollo", "apify"] as EnrichProvider[]).map((p) => {
                    const idx = settings.providers.indexOf(p);
                    return (
                      <label key={p} className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-sm hover:bg-sunken">
                        <input
                          type="checkbox"
                          checked={idx !== -1}
                          onChange={(e) =>
                            setSettings((s) => ({
                              ...s,
                              providers: e.target.checked ? [...s.providers, p] : s.providers.filter((x) => x !== p),
                            }))
                          }
                          className="accent-accent"
                        />
                        <span className="tabular w-4 font-mono text-xs text-muted">{idx !== -1 ? idx + 1 : ""}</span>
                        {PROVIDER_LABEL[p]}
                      </label>
                    );
                  })}
                </div>
                <p className="mt-2 text-xs text-muted">The first provider with a match wins, so later ones are not charged.</p>
                <label className="mt-3 flex items-center justify-between gap-3 text-sm">
                  People Data Labs minimum likelihood
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={settings.minLikelihood}
                    onChange={(e) => setSettings((s) => ({ ...s, minLikelihood: Number(e.target.value) || 6 }))}
                    className={`${control} tabular w-20 px-2 py-1 text-center`}
                  />
                </label>
              </section>

              <section>
                <h3 className="mb-2 text-sm font-semibold">Patent search</h3>
                <select value={source} onChange={(e) => setSource(e.target.value as typeof source)} className={input}>
                  <option value="auto">USPTO, then Google, then Apify (recommended)</option>
                  <option value="uspto">USPTO Patent Public Search only (free)</option>
                  <option value="google-patents">Google Patents only (free)</option>
                  <option value="google-patents-apify">Always through Apify (about $0.03 per 100 patents)</option>
                </select>
              </section>

              <section>
                <h3 className="mb-2 text-sm font-semibold">Browser key overrides</h3>
                <div className="grid gap-3">
                  <KeyInput label="People Data Labs API key" value={settings.keys.pdl} onChange={(v) => setSettings((s) => ({ ...s, keys: { ...s.keys, pdl: v } }))} />
                  <KeyInput label="Apify token" value={settings.keys.apify} onChange={(v) => setSettings((s) => ({ ...s, keys: { ...s.keys, apify: v } }))} />
                  <KeyInput label="Apollo API key" value={settings.keys.apollo} onChange={(v) => setSettings((s) => ({ ...s, keys: { ...s.keys, apollo: v } }))} />
                </div>
              </section>

              <details className="group">
                <summary className="cursor-pointer text-sm font-semibold marker:text-faint">Advanced: custom Apify actor</summary>
                <div className="mt-3 grid gap-3">
                  <label className="block">
                    <span className={labelText}>Actor ID</span>
                    <input
                      value={settings.apifyActorId}
                      onChange={(e) => setSettings((s) => ({ ...s, apifyActorId: e.target.value }))}
                      placeholder="apify~google-search-scraper"
                      className={`${input} font-mono text-xs`}
                    />
                  </label>
                  <label className="block">
                    <span className={labelText}>Input template (JSON, optional)</span>
                    <textarea
                      value={settings.apifyInput}
                      onChange={(e) => setSettings((s) => ({ ...s, apifyInput: e.target.value }))}
                      placeholder='{"queries":"{query}","maxPagesPerQuery":1}'
                      rows={3}
                      className={`${input} font-mono text-xs`}
                    />
                    <span className="mt-1 block text-xs text-faint">Placeholders: {"{firstName} {lastName} {fullName} {company} {location} {query}"}</span>
                  </label>
                </div>
              </details>
            </div>
          </aside>
        </div>
      )}
    </main>
  );
}

/* ───────────────────────── sub-components ───────────────────────── */

function InventorRow({
  inv,
  state,
  patentsById,
  canEnrich,
  showLocation,
  inLedger,
  onEnrich,
  onChoose,
  onSave,
}: {
  inv: Inventor;
  state?: EnrichState;
  patentsById: Map<string, Patent>;
  canEnrich: boolean;
  showLocation: boolean;
  inLedger: Set<string>;
  onEnrich: () => void;
  onChoose: (i: number) => void;
  onSave: (c: Candidate) => void;
}) {
  const [open, setOpen] = useState(false);
  const chosen = state?.result?.candidates[state.chosen ?? 0];
  const brand = employerFromAssignee(inv.assignee, inv.fullName).brand;
  const manualSearch = `https://www.google.com/search?q=${encodeURIComponent(`site:linkedin.com/in "${inv.fullName}"${brand ? ` ${brand}` : ""}`)}`;

  return (
    <tr className="align-top transition-colors hover:bg-sunken/60">
      <td className="px-4 py-3">
        <div className="font-medium text-ink">{inv.fullName}</div>
        <div className="mt-0.5 text-xs text-muted">
          {inv.assignee || "No assignee"}
          {inv.assignees.length > 1 && <span className="text-faint"> +{inv.assignees.length - 1}</span>}
        </div>
      </td>
      {showLocation && <td className="px-4 py-3 text-xs text-muted">{[inv.city, inv.state, inv.country].filter(Boolean).join(", ") || "—"}</td>}
      <td className="px-4 py-3 text-xs">
        <button type="button" onClick={() => setOpen((o) => !o)} className="tabular font-medium text-accent hover:underline" aria-expanded={open}>
          {inv.patentCount} patent{inv.patentCount === 1 ? "" : "s"} {open ? "▴" : "▾"}
        </button>
        {inv.latestDate && <div className="tabular mt-0.5 font-mono text-[11px] text-faint">{inv.latestDate}</div>}
        {open && (
          <ul className="mt-2 grid max-w-xs gap-1">
            {inv.patentIds.map((id) => {
              const p = patentsById.get(id);
              return (
                <li key={id} className="leading-snug">
                  <a href={p?.url || `https://patents.google.com/patent/${id}`} target="_blank" rel="noreferrer" className="text-muted hover:text-ink hover:underline">
                    {p?.title || id}
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </td>
      <td className="px-4 py-3">
        {(!state || state.status === "idle") && (
          <button type="button" disabled={!canEnrich} onClick={onEnrich} className={`${btnSecondary} py-1 text-xs`}>
            <LinkedInIcon />
            Find LinkedIn
          </button>
        )}
        {state?.status === "loading" && (
          <span className="inline-flex items-center gap-2 text-xs text-muted">
            <Spinner /> Looking up…
          </span>
        )}
        {state?.status === "error" && (
          <div className="rounded-md border border-danger/25 bg-danger-soft px-3 py-2 text-xs text-danger">
            {state.error}{" "}
            <button type="button" onClick={onEnrich} className="font-medium underline">
              Retry
            </button>
          </div>
        )}
        {state?.status === "done" && state.result && (
          <div className="grid gap-1.5">
            {chosen?.linkedinUrl ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <ScoreBadge score={chosen.score} />
                  <a href={chosen.linkedinUrl} target="_blank" rel="noreferrer" className="font-medium text-accent hover:underline">
                    {chosen.fullName || chosen.linkedinUrl.replace("https://www.linkedin.com/in/", "")}
                  </a>
                  <span className="text-[11px] text-faint">via {chosen.provider}</span>
                </div>
                {(chosen.title || chosen.company || chosen.location) && (
                  <div className="text-xs text-muted">{[chosen.title, chosen.company, chosen.location].filter(Boolean).join(" · ")}</div>
                )}
                <div className="flex flex-wrap gap-1">
                  {chosen.reasons.map((r) => (
                    <span key={r} className="rounded bg-check-soft px-1.5 py-px text-[10.5px] text-check">
                      {r}
                    </span>
                  ))}
                </div>
                {state.result.candidates.length > 1 && (
                  <select
                    value={state.chosen ?? 0}
                    onChange={(e) => onChoose(Number(e.target.value))}
                    className="w-fit max-w-full rounded-md border border-line bg-surface px-2 py-1 text-xs text-muted hover:border-line-strong"
                    aria-label="Other candidates"
                  >
                    {state.result.candidates.map((c, i) => (
                      <option key={i} value={i}>
                        {c.score} · {c.fullName || c.linkedinUrl} {c.company ? `(${c.company})` : ""}
                      </option>
                    ))}
                  </select>
                )}
                <div className="mt-0.5 flex flex-wrap items-center gap-3">
                  {inLedger.has(chosen.linkedinUrl) ? (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-strong">✓ In ledger</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onSave(chosen)}
                      className={chosen.score >= 45 ? `${btnPrimary} px-2.5 py-1 text-xs` : `${btnSecondary} px-2.5 py-1 text-xs`}
                    >
                      Save to ledger
                    </button>
                  )}
                  <button type="button" onClick={onEnrich} className={btnGhost}>
                    Re-run
                  </button>
                  <a href={manualSearch} target="_blank" rel="noreferrer" className={btnGhost}>
                    Search manually
                  </a>
                </div>
              </>
            ) : (
              <div className="text-xs text-muted">
                No match.{" "}
                <a href={manualSearch} target="_blank" rel="noreferrer" className="font-medium text-accent hover:underline">
                  Search manually
                </a>
              </div>
            )}
            <details className="text-[11px] text-faint">
              <summary className="w-fit cursor-pointer hover:text-muted">Attempts</summary>
              <div className="mt-1 grid gap-0.5 font-mono">
                {state.result.attempts.map((a, i) => (
                  <div key={i}>
                    {a.provider}: {a.status}
                    {a.detail ? ` (${a.detail})` : ""} · {a.ms} ms
                  </div>
                ))}
              </div>
            </details>
          </div>
        )}
      </td>
    </tr>
  );
}

function ScoreBadge({ score }: { score: number }) {
  const [label, cls] =
    score >= 70
      ? ["Strong", "bg-strong-soft text-strong ring-strong/20"]
      : score >= 45
        ? ["Likely", "bg-likely-soft text-likely ring-likely/20"]
        : ["Check", "bg-check-soft text-check ring-check/20"];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${cls}`} title={`Match score ${score} of 100`}>
      {label}
      <span className="tabular font-mono">{score}</span>
    </span>
  );
}

function StatusPill({ label, value, ok, loading }: { label: string; value?: string; ok: boolean; loading?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
        loading ? "border-line text-faint" : ok ? "border-strong/25 bg-strong-soft/60 text-ink" : "border-line text-faint"
      }`}
      title={loading ? "Checking…" : ok ? `${label}: connected` : `${label}: no key`}
    >
      <Dot ok={ok && !loading} />
      {label}
      {value && <span className="text-muted">{value}</span>}
    </span>
  );
}

function Dot({ ok }: { ok: boolean }) {
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${ok ? "bg-strong" : "bg-line-strong"}`} aria-hidden />;
}

function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <div className="flex h-11 shrink-0 rounded-md border border-line bg-sunken p-1" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`flex-1 whitespace-nowrap rounded px-3 text-xs font-medium transition-colors sm:flex-none ${value === o.value ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function KeyInput({
  label,
  value,
  onChange,
  placeholder = "Uses the server key when empty",
}: {
  label: string;
  value?: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <label className="block">
      <span className={labelText}>{label}</span>
      <div className="flex">
        <input
          type={show ? "text" : "password"}
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
          placeholder={placeholder}
          className={`${input} rounded-r-none font-mono text-xs`}
        />
        <button type="button" onClick={() => setShow((s) => !s)} className="rounded-r-md border border-l-0 border-line bg-sunken px-3 text-xs text-muted hover:text-ink">
          {show ? "Hide" : "Show"}
        </button>
      </div>
    </label>
  );
}

function Notice({ tone, children }: { tone: "warn" | "error" | "info"; children: React.ReactNode }) {
  const cls =
    tone === "error"
      ? "border-danger/25 bg-danger-soft text-danger"
      : tone === "warn"
        ? "border-likely/25 bg-likely-soft text-likely"
        : "border-line bg-surface text-muted";
  return <div className={`mt-3 rounded-lg border px-3.5 py-2.5 text-sm ${cls}`}>{children}</div>;
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-dashed border-line-strong bg-surface/60 px-6 py-12 text-center">
      <div className="text-sm font-medium text-ink">{title}</div>
      <div className="mt-1 text-sm text-muted">{body}</div>
    </div>
  );
}

function SearchIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="7" cy="7" r="4.75" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="2.25" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M8 1.75v1.5M8 12.75v1.5M14.25 8h-1.5M3.25 8h-1.5M12.42 3.58l-1.06 1.06M4.64 11.36l-1.06 1.06M12.42 12.42l-1.06-1.06M4.64 4.64 3.58 3.58"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function LinkedInIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
      <rect width="16" height="16" rx="3" fill="#0a66c2" />
      <path d="M4.3 6.4h1.9V12H4.3zM5.25 3.6a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2M7.4 6.4h1.8v.77c.25-.47.87-.95 1.8-.95 1.92 0 2.28 1.26 2.28 2.9V12h-1.9V9.4c0-.62-.01-1.42-.87-1.42-.86 0-1 .68-1 1.38V12H7.4z" fill="#fff" />
    </svg>
  );
}

function Spinner() {
  return <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-line-strong border-t-accent" aria-hidden />;
}
