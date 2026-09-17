import type { LedgerKeys } from "./types";
import { authEnabled, sessionUserFromRequest } from "../auth";

/** Header the browser uses to hand its own API keys to the route handlers. */
export const KEYS_HEADER = "x-ledger-keys";

/**
 * Resolve API keys for one request.
 *
 * Keys pasted into the UI arrive in the `x-ledger-keys` header (JSON) and always
 * win. Server-side env keys are only used for a signed-in user or a machine-local
 * install, so nobody who merely finds the URL can spend the owner's credits.
 */
export function resolveKeys(request: Request): LedgerKeys {
  const fromHeader = parseHeader(request.headers.get(KEYS_HEADER));
  const envAllowed = serverKeysUnlocked(request);

  const fromEnv: LedgerKeys = envAllowed
    ? {
        patentsview: process.env.PATENTSVIEW_API_KEY,
        pdl: process.env.PDL_API_KEY,
        apollo: process.env.APOLLO_API_KEY,
        apify: process.env.APIFY_TOKEN,
      }
    : {};

  return {
    patentsview: clean(fromHeader.patentsview) || clean(fromEnv.patentsview),
    pdl: clean(fromHeader.pdl) || clean(fromEnv.pdl),
    apollo: clean(fromHeader.apollo) || clean(fromEnv.apollo),
    apify: clean(fromHeader.apify) || clean(fromEnv.apify),
  };
}

/**
 * Server env keys are usable when either:
 *  - login is configured (PATENT_LEDGER_USERS) and the request carries a valid session, or
 *  - login is not configured and PATENT_LEDGER_TRUST_LOCAL=1 (a machine-local install; the npm
 *    scripts bind to 127.0.0.1, so nothing off this machine can reach the routes).
 */
export function serverKeysUnlocked(request: Request): boolean {
  if (authEnabled()) return !!sessionUserFromRequest(request);
  return process.env.PATENT_LEDGER_TRUST_LOCAL === "1";
}

function parseHeader(raw: string | null): LedgerKeys {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      patentsview: str(parsed.patentsview),
      pdl: str(parsed.pdl),
      apollo: str(parsed.apollo),
      apify: str(parsed.apify),
    };
  } catch {
    return {};
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function clean(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}
