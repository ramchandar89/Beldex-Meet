import { NextRequest, NextResponse } from "next/server";

// Browsers only allow camera/microphone on https:// pages or localhost. When
// someone opens a page from another machine over plain http (e.g.
// http://192.168.x.x:3003), send them to the HTTPS proxy (scripts/lan-proxy.mjs)
// instead of letting the meeting fail with "media devices unavailable".
//
// API routes are excluded (see `config`) so the mobile app, which talks to
// http://<ip>:3003/api directly, keeps working.

const HTTPS_PORT = process.env.LAN_HTTPS_PORT ?? "3443";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function middleware(req: NextRequest) {
  // Requests that came through the HTTPS proxy are already secure.
  if (req.headers.get("x-forwarded-proto") === "https") return NextResponse.next();

  const host = req.headers.get("host") ?? "";
  const hostname = host.replace(/:\d+$/, "");
  if (!hostname || LOCAL_HOSTS.has(hostname)) return NextResponse.next();

  const url = new URL(req.url);
  return NextResponse.redirect(
    `https://${hostname}:${HTTPS_PORT}${url.pathname}${url.search}`,
    307,
  );
}

export const config = {
  // Pages only: skip API routes and Next.js internals/static files.
  matcher: ["/((?!api/|_next/|favicon.ico).*)"],
};
