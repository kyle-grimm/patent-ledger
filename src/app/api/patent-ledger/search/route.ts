import { NextResponse } from "next/server";
import type { SearchRequest, SearchResponse } from "@/lib/patent-ledger/types";
import { resolveKeys } from "@/lib/patent-ledger/keys";
import { searchPatentsView } from "@/lib/patent-ledger/patentsview";
import { GoogleBlockedError, searchGooglePatents } from "@/lib/patent-ledger/google-patents";
import { searchPatentsViaApify } from "@/lib/patent-ledger/apify-patents";
import { searchUsptoPatents } from "@/lib/patent-ledger/uspto-ppubs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/patent-ledger/search
 * Body: SearchRequest. Keys via the x-ledger-keys header or unlocked server env (lib/patent-ledger/keys.ts).
 *
 * Order for source=auto:
 *   1. PatentsView, only when a key is present (the public API was retired into the USPTO Open
 *      Data Portal in 2026, so this normally does not run).
 *   2. USPTO Patent Public Search (free, no key, inventor locations).
 *   3. Google Patents directly (free) if the USPTO service fails.
 *   4. Google Patents through Apify when Google blocks direct requests and an Apify key is available.
 */
export async function POST(request: Request) {
  let body: SearchRequest;
  try {
    body = (await request.json()) as SearchRequest;
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  if (!body || typeof body.query !== "string") {
    return NextResponse.json({ error: "`query` (string) is required." }, { status: 400 });
  }
  const hasFilter = body.query.trim() || body.assignee?.trim() || body.cpcPrefixes?.some((c) => c.trim());
  if (!hasFilter) {
    return NextResponse.json({ error: "Enter keywords, a CPC code, or a company." }, { status: 400 });
  }

  const keys = resolveKeys(request);
  const source = body.source || "auto";
  const warnings: string[] = [];

  if (source === "patentsview" || (source === "auto" && keys.patentsview)) {
    try {
      const result = await searchPatentsView(body, keys.patentsview || "");
      return NextResponse.json(result satisfies SearchResponse);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (source === "patentsview") return NextResponse.json({ error: msg }, { status: 502 });
      warnings.push(`PatentsView failed (${msg}); used Google Patents.`);
    }
  }

  if (source === "uspto" || source === "auto") {
    try {
      const result = await searchUsptoPatents(body);
      result.warnings = [...warnings, ...result.warnings];
      return NextResponse.json(result satisfies SearchResponse);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (source === "uspto") return NextResponse.json({ error: msg }, { status: 502 });
      warnings.push(`${msg} Used Google Patents instead.`);
    }
  }

  if (source === "auto" || source === "google-patents") {
    try {
      const result = await searchGooglePatents(body);
      result.warnings = [...warnings, ...result.warnings];
      return NextResponse.json(result satisfies SearchResponse);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const canRetryViaApify = err instanceof GoogleBlockedError && !!keys.apify && source === "auto";
      if (!canRetryViaApify) {
        const hint = err instanceof GoogleBlockedError && !keys.apify ? " Add an Apify token to search through Apify instead." : "";
        return NextResponse.json({ error: [...warnings, msg + hint].join(" ") }, { status: 502 });
      }
      warnings.push(`${msg} Searched through Apify instead (about $0.03 per 100 patents).`);
    }
  }

  if (!keys.apify) {
    return NextResponse.json({ error: "Searching through Apify needs an Apify token." }, { status: 400 });
  }
  try {
    const result = await searchPatentsViaApify(body, keys.apify);
    result.warnings = [...warnings, ...result.warnings];
    return NextResponse.json(result satisfies SearchResponse);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: [...warnings, msg].join(" ") }, { status: 502 });
  }
}
