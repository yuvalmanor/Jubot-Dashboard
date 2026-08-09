import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

import { isAllowed, parseAllowList } from "@/domain/access/allow-list";

/**
 * Google OAuth with an allow-list of exactly two accounts (ADR 0004). There are no
 * roles and no permissions — every route is authenticated and there is no public
 * surface. Sessions are JWTs, so no adapter and no session table: the free tier
 * stays free.
 */

export function householdAllowList(): readonly string[] {
  return parseAllowList(process.env.JUBOT_ALLOWED_EMAILS);
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  session: { strategy: "jwt" },
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID ?? "",
      clientSecret: process.env.AUTH_GOOGLE_SECRET ?? "",
    }),
  ],
  pages: {
    signIn: "/signin",
    error: "/signin",
  },
  callbacks: {
    /**
     * The gate. An address that is not one of the two never gets a session, so no
     * route can render data for it — the refusal happens before any token exists.
     */
    signIn({ user, profile }) {
      return isAllowed(profile?.email ?? user.email, householdAllowList());
    },
  },
});
