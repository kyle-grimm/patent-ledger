import { NextResponse } from "next/server";
import { resolveKeys } from "@/lib/patent-ledger/keys";
import { authEnabled, sessionUserFromRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/patent-ledger/status
 * Which providers this request can use (browser keys + unlocked server keys) and who is signed in.
 * Booleans only; key values never leave the server.
 */
export async function GET(request: Request) {
  const keys = resolveKeys(request);
  return NextResponse.json({
    user: authEnabled() ? sessionUserFromRequest(request) ?? null : null,
    providers: {
      pdl: !!keys.pdl,
      apollo: !!keys.apollo,
      apify: !!keys.apify,
      patentsview: !!keys.patentsview,
    },
  });
}
