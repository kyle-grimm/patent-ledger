import { NextResponse } from "next/server";
import type { EnrichRequest, EnrichResponse } from "@/lib/patent-ledger/types";
import { resolveKeys } from "@/lib/patent-ledger/keys";
import { enrichInventor } from "@/lib/patent-ledger/enrich";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/patent-ledger/enrich
 * Body: EnrichRequest. One inventor per call ("light" enrichment): providers are
 * tried in order and the first match wins, so a PDL hit never also spends an
 * Apollo credit or an Apify run.
 */
export async function POST(request: Request) {
  let body: EnrichRequest;
  try {
    body = (await request.json()) as EnrichRequest;
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const inv = body?.inventor;
  if (!inv || !inv.lastName?.trim()) {
    return NextResponse.json({ error: "`inventor.lastName` is required." }, { status: 400 });
  }

  const keys = resolveKeys(request);
  if (!keys.pdl && !keys.apollo && !keys.apify) {
    return NextResponse.json(
      { error: "No enrichment keys. Add a People Data Labs, Apollo, or Apify key in Settings." },
      { status: 400 },
    );
  }

  const result = await enrichInventor(body, keys);
  return NextResponse.json(result satisfies EnrichResponse);
}
