import { NextResponse } from "next/server";

import { auth } from "@/auth";

/**
 * Every route is authenticated. An unsigned-in visitor never reaches a page that
 * renders data — the redirect happens before the route runs.
 */
export default auth((request) => {
  const isSignInPage = request.nextUrl.pathname === "/signin";

  if (!request.auth && !isSignInPage) {
    const signInUrl = new URL("/signin", request.nextUrl.origin);
    return NextResponse.redirect(signInUrl);
  }

  if (request.auth && isSignInPage) {
    return NextResponse.redirect(new URL("/", request.nextUrl.origin));
  }

  return NextResponse.next();
});

export const config = {
  // Everything except the auth endpoints themselves and static assets.
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon.ico).*)"],
};
