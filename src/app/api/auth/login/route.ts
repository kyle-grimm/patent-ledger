import { NextResponse } from "next/server";
import { authEnabled, checkPassword, createSessionValue, SESSION_COOKIE, SESSION_TTL_SECONDS } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** POST /api/auth/login  {username, password} → sets the session cookie. */
export async function POST(request: Request) {
  if (!authEnabled()) return NextResponse.json({ ok: true, user: null });
  let body: { username?: unknown; password?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";
  const user = username && password ? checkPassword(username, password) : undefined;
  if (!user) {
    await new Promise((r) => setTimeout(r, 600)); // slow down guessing
    return NextResponse.json({ error: "Wrong username or password." }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true, user });
  res.cookies.set(SESSION_COOKIE, createSessionValue(user), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return res;
}
