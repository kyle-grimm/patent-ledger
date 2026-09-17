import { createHmac, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Login for hosted installs.
 *
 *   PATENT_LEDGER_USERS           JSON {"admin":"scrypt$<salt b64>$<hash b64>", "kyle": "..."}
 *                                 (make entries with `node scripts/hash-password.mjs <password>`)
 *   PATENT_LEDGER_SESSION_SECRET  random string, signs session cookies
 *
 * Login is required only when PATENT_LEDGER_USERS is set, so a machine-local install keeps working
 * without one. Sessions are HMAC-signed cookies: `<base64url {u,exp}>.<base64url hmac>`.
 */

export const SESSION_COOKIE = "pl_session";
export const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60;

type Users = Record<string, string>;

export function authEnabled(): boolean {
  return Object.keys(users()).length > 0;
}

function users(): Users {
  const raw = process.env.PATENT_LEDGER_USERS;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter(([, v]) => typeof v === "string")
        .map(([k, v]) => [k.toLowerCase(), v as string]),
    );
  } catch {
    return {};
  }
}

function secret(): string {
  const s = process.env.PATENT_LEDGER_SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("PATENT_LEDGER_SESSION_SECRET must be set (32+ characters).");
  return s;
}

/** Returns the canonical username when the credentials are valid. */
export function checkPassword(username: string, password: string): string | undefined {
  const name = username.trim().toLowerCase();
  const stored = users()[name];
  // Hash even for unknown users so response time does not reveal which usernames exist.
  const [scheme, saltB64, hashB64] = (stored || "scrypt$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return undefined;
  const expected = Buffer.from(hashB64, "base64url");
  const actual = scryptSync(password, Buffer.from(saltB64, "base64url"), expected.length || 32);
  const ok = expected.length === actual.length && timingSafeEqual(expected, actual);
  return ok && stored ? name : undefined;
}

export function createSessionValue(username: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ u: username, exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** The signed-in username, or undefined for a missing, tampered, expired or revoked session. */
export function verifySessionValue(value: string | undefined, now = Date.now()): string | undefined {
  if (!value) return undefined;
  const [payload, mac] = value.split(".");
  if (!payload || !mac) return undefined;
  let expected: Buffer;
  try {
    expected = Buffer.from(sign(payload), "base64url");
  } catch {
    return undefined;
  }
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  try {
    const { u, exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { u?: string; exp?: number };
    if (!u || typeof exp !== "number" || exp * 1000 < now) return undefined;
    // Removing a user from PATENT_LEDGER_USERS ends their sessions.
    return users()[u] ? u : undefined;
  } catch {
    return undefined;
  }
}

export function sessionUserFromRequest(request: Request): string | undefined {
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return verifySessionValue(match ? decodeURIComponent(match[1]) : undefined);
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}
