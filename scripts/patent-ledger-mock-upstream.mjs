#!/usr/bin/env node
/**
 * Offline stand-in for PatentsView, Google Patents, People Data Labs, Apollo and
 * Apify so the patent-ledger routes can be exercised end to end without network
 * access or spending credits. Response shapes mirror the real APIs.
 *
 *   node scripts/patent-ledger-mock-upstream.mjs [port]
 *
 * Then run Next with every PATENT_LEDGER_*_BASE pointed at http://127.0.0.1:<port>
 * (see scripts/patent-ledger-smoke.mjs, which does all of this for you).
 */
import http from "node:http";

const port = Number(process.argv[2] || 4010);
const log = [];

const PATENTS = [
  {
    patent_id: "11994321",
    patent_title: "High-resolution microdisplay for head-mounted virtual reality systems",
    patent_abstract: "A head-mounted display includes a high resolution micro-OLED panel and pancake optics for virtual reality.",
    patent_date: "2024-05-28",
    patent_type: "utility",
    application: [{ filing_date: "2022-03-14" }],
    inventors: [
      { inventor_id: "fl:ma_ln:vance-1", inventor_name_first: "Maria", inventor_name_last: "Vance", inventor_city: "Redmond", inventor_state: "WA", inventor_country: "US" },
      { inventor_id: "fl:de_ln:okafor-1", inventor_name_first: "Dele", inventor_name_last: "Okafor", inventor_city: "Seattle", inventor_state: "WA", inventor_country: "US" },
    ],
    assignees: [{ assignee_organization: "Meta Platforms Technologies, LLC" }],
    cpc_current: [{ cpc_group_id: "G02B27/0172" }, { cpc_group_id: "G09G3/3208" }],
  },
  {
    patent_id: "11876543",
    patent_title: "Foveated rendering pipeline for virtual reality displays",
    patent_abstract: "Eye-tracked foveated rendering for high resolution display panels in virtual reality headsets.",
    patent_date: "2024-01-16",
    patent_type: "utility",
    application: [{ filing_date: "2021-11-02" }],
    inventors: [
      { inventor_id: "fl:ma_ln:vance-1", inventor_name_first: "Maria", inventor_name_last: "Vance", inventor_city: "Redmond", inventor_state: "WA", inventor_country: "US" },
      { inventor_id: "fl:pr_ln:shah-1", inventor_name_first: "Priya", inventor_name_last: "Shah", inventor_city: "Sunnyvale", inventor_state: "CA", inventor_country: "US" },
    ],
    assignees: [{ assignee_organization: "Meta Platforms Technologies, LLC" }],
    cpc_current: [{ cpc_group_id: "G02B27/017" }, { cpc_group_id: "G06F3/013" }],
  },
];

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const body = await readBody(req);
  log.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });

  // Introspection for the smoke test.
  if (url.pathname === "/__log") return json(res, 200, log);

  // USPTO Patent Public Search (ppubs)
  if (url.pathname === "/api/users/me/session" && req.method === "POST") {
    res.writeHead(200, { "Content-Type": "application/json", "x-access-token": "uspto-mock-token" });
    return res.end(JSON.stringify({ userCase: { caseId: 77 }, role: "ANONYMOUS_USER" }));
  }
  if (/^\/api\/(searches|patents)\//.test(url.pathname) && req.headers["x-access-token"] !== "uspto-mock-token") {
    return json(res, 401, { message: "unauthorized" });
  }
  if (url.pathname === "/api/searches/searchWithBeFamily") {
    const q = JSON.parse(body || "{}").query?.q || "";
    // Queries mentioning "blocked" or "googleonly" simulate the USPTO service being down.
    if (/blocked|googleonly/.test(q)) return json(res, 500, { message: "mock outage" });
    return json(res, 200, {
      numFound: 2,
      patents: [
        { guid: "US-11111111-B2", type: "USPAT", inventorsShort: "Vance; Maria et al.", assigneeName: ["Meta Platforms Technologies, LLC"], inventionTitle: "Waveguide display" },
        { guid: "US-20240000001-A1", type: "US-PGPUB", inventorsShort: "Shah; Priya", assigneeName: ["Meta Platforms Technologies, LLC"], inventionTitle: "Eye tracking" },
      ],
    });
  }
  const highlight = url.pathname.match(/^\/api\/patents\/highlight\/(.+)$/);
  if (highlight) {
    const guid = decodeURIComponent(highlight[1]);
    if (guid === "US-11111111-B2") {
      return json(res, 200, {
        guid, inventionTitle: "Waveguide <span>display</span>", abstractHtml: "<p>A waveguide display.</p>", datePublished: "2024-05-28T00:00:00Z",
        applicationFilingDate: ["2022-03-14T00:00:00Z"], assigneeName: ["Meta Platforms Technologies, LLC"], cpcInventiveFlattened: "G02B27/0172;G02B6/00",
        inventorsName: ["Vance; Maria", "Okafor; Dele"], inventorCity: ["Redmond", "Seattle"], inventorState: ["WA", "WA"], inventorCountry: ["US", "US"],
      });
    }
    // The application record is rate-limited on its first request, like the real service under load.
    const seen = log.filter((e) => e.path === url.pathname).length;
    if (seen === 1) {
      res.writeHead(429, { "Content-Type": "application/json", "x-rate-limit-retry-after-seconds": "0" });
      return res.end(JSON.stringify({ message: "Too many requests" }));
    }
    return json(res, 200, {
      guid, inventionTitle: "Eye tracking", datePublished: "2024-01-04T00:00:00Z", applicationFilingDate: ["2023-01-10T00:00:00Z"],
      assigneeName: ["Meta Platforms Technologies, LLC"], inventorsName: ["Shah; Priya"], inventorCity: ["Sunnyvale"], inventorState: ["CA"], inventorCountry: ["US"],
    });
  }

  // PatentsView
  if (url.pathname === "/api/v1/patent/") {
    if (req.headers["x-api-key"] !== "pv-test-key") return json(res, 403, { error: true, message: "Forbidden" });
    const q = JSON.parse(body || "{}");
    return json(res, 200, { error: false, count: PATENTS.length, total_hits: 2, patents: PATENTS, _echo_q: q.q });
  }

  // Google Patents XHR
  if (url.pathname === "/xhr/query") {
    // A query containing "blocked" gets Google's rate-limit response.
    if (/blocked/.test(url.searchParams.get("url") || "")) return json(res, 503, { error: "Sorry..." });
    return json(res, 200, {
      results: {
        total_num_results: 1,
        cluster: [
          {
            result: [
              {
                patent: {
                  publication_number: "US11994321B2",
                  title: "High-resolution <b>microdisplay</b> for head-mounted virtual reality systems",
                  snippet: "A head-mounted display includes a high resolution micro-OLED panel…",
                  inventor: "Maria Vance, Dele Okafor",
                  assignee: "Meta Platforms Technologies, LLC",
                  grant_date: "2024-05-28",
                  filing_date: "2022-03-14",
                },
              },
            ],
          },
        ],
      },
    });
  }

  // People Data Labs
  if (url.pathname === "/v5/person/enrich") {
    if (req.headers["x-api-key"] !== "pdl-test-key") return json(res, 401, { status: 401, error: { message: "Invalid API key" } });
    if (url.searchParams.get("last_name") === "Vance") {
      return json(res, 200, {
        status: 200,
        likelihood: 9,
        data: {
          full_name: "maria vance",
          linkedin_url: "linkedin.com/in/maria-vance-display",
          job_title: "staff display engineer",
          job_company_name: "meta",
          location_name: "redmond, washington, united states",
        },
      });
    }
    return json(res, 404, { status: 404, error: { type: "not_found", message: "No records were found matching your request" } });
  }

  // Apollo
  if (url.pathname === "/api/v1/people/match") {
    if (req.headers["x-api-key"] !== "apollo-test-key") return json(res, 401, { error: "Invalid API key" });
    const b = JSON.parse(body || "{}");
    if (b.last_name === "Okafor") {
      return json(res, 200, {
        person: {
          first_name: "Dele",
          last_name: "Okafor",
          name: "Dele Okafor",
          linkedin_url: "http://www.linkedin.com/in/dele-okafor",
          title: "Optical Systems Lead",
          city: "Seattle",
          state: "Washington",
          country: "United States",
          organization: { name: "Meta", primary_domain: "meta.com" },
        },
      });
    }
    return json(res, 200, { person: null });
  }

  // Apify run-sync-get-dataset-items
  const apify = url.pathname.match(/^\/v2\/acts\/([^/]+)\/run-sync-get-dataset-items$/);
  if (apify) {
    if (url.searchParams.get("token") !== "apify-test-token") return json(res, 401, { error: { type: "token-not-found" } });
    const input = JSON.parse(body || "{}");
    if (apify[1] === "fetch_cat~google-patents-search-scraper") {
      // Google Patents actor: includes a non-US record and an out-of-range one that the app must drop.
      return json(res, 200, [
        { publicationNumber: "US12000001B2", patentTitle: "Blocked-path waveguide display", inventors: ["Maria Vance", "Ravi Drop"], assignees: ["Meta Platforms Technologies, LLC"], priorityDate: "2021-02-01", publicationDate: "2024-01-02", patentUrl: "https://patents.google.com/patent/US12000001B2/en" },
        { publicationNumber: "CN100000001A", patentTitle: "Foreign record", inventors: ["Li Wei"], assignees: ["Some Co"], priorityDate: "2021-02-01" },
        { publicationNumber: "US9000001B2", patentTitle: "Old record", inventors: ["Old Timer"], assignees: ["Meta Platforms Technologies, LLC"], priorityDate: "2009-05-05" },
      ]);
    }
    // Like the real actor: one dataset item per query (newline-separated), keyed by searchQuery.term.
    const terms = String(input.queries || "").split("\n").filter(Boolean);
    const items = terms.map((term) => {
      if (/"Priya Shah" Meta$/.test(term)) {
        return {
          searchQuery: { term },
          organicResults: [
            { title: "Priya Shah - Senior Rendering Engineer - Meta | LinkedIn", url: "https://www.linkedin.com/in/priya-shah-gfx", description: "Sunnyvale, California, United States · Foveated rendering…" },
            { title: "Pranav Shah - Display Engineer - Meta | LinkedIn", url: "https://www.linkedin.com/in/pranav-shah-meta", description: "Menlo Park" },
            { title: "Meta Reality Labs | LinkedIn", url: "https://www.linkedin.com/company/meta", description: "" },
          ],
        };
      }
      if (/"Priya Shah"$/.test(term)) {
        return {
          searchQuery: { term },
          organicResults: [
            { title: "Priya Shah - Accountant - Deloitte | LinkedIn", url: "https://in.linkedin.com/in/priya-shah-acct", description: "Mumbai, Maharashtra, India" },
            { title: "Priya Shah - Rendering", url: "https://www.linkedin.com/in/priya-shah-gfx", description: "Experience: Meta · Location: Sunnyvale" },
          ],
        };
      }
      if (/"Ravi Drop"$/.test(term)) {
        return { searchQuery: { term }, organicResults: [{ title: "Ravi Drop - Engineer at Waymo", url: "https://www.linkedin.com/in/ravi-drop", description: "" }] };
      }
      return { searchQuery: { term }, organicResults: [] };
    });
    // Simulate the actor dropping a query's page on the first multi-query run for "Ravi Drop".
    if (terms.length > 1 && terms.some((t) => /Ravi Drop/.test(t))) {
      return json(res, 200, items.filter((it) => !/"Ravi Drop"$/.test(it.searchQuery.term)));
    }
    return json(res, 200, items);
  }

  json(res, 404, { error: `mock: no route for ${req.method} ${url.pathname}` });
});

server.listen(port, "127.0.0.1", () => console.log(`mock upstream on http://127.0.0.1:${port}`));
