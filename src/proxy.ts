import { NextResponse, type NextRequest } from "next/server";
import { authEnabled, SESSION_COOKIE, verifySessionValue } from "@/lib/auth";

/**
 * Login gate for hosted installs. Route handlers verify the session again before using server keys
 * (lib/patent-ledger/keys.ts), so this is not the only check.
 */
export function proxy(request: NextRequest) {
  if (!authEnabled()) return NextResponse.next();
  const user = verifySessionValue(request.cookies.get(SESSION_COOKIE)?.value);
  if (user) return NextResponse.next();

  const { pathname, search } = request.nextUrl;
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  const login = new URL("/login", request.url);
  if (pathname !== "/") login.searchParams.set("next", pathname + search);
  return NextResponse.redirect(login);
}

export const config = {
  // Everything except the login page, the login/logout API, Next assets and robots.txt.
  matcher: ["/((?!login|api/auth/|_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
