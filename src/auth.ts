import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
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

/**
 * Whether the development sign-in is available.
 *
 * Real Google sign-in needs a real OAuth client, which a local checkout does not
 * have — so without this there is no way to reach a single screen locally except
 * by forging a session cookie by hand. This is that, made honest: an ordinary
 * Auth.js provider, subject to the same allow-list as Google, that exists only
 * when the app is not built for production.
 *
 * `NODE_ENV` is `production` in any `next build`, which is what Vercel runs, so
 * a deployment never carries this provider at all — it is absent from the
 * provider list rather than merely refusing.
 */
export function developmentSignInEnabled(): boolean {
  return process.env.NODE_ENV !== "production";
}

const developmentProviders = developmentSignInEnabled()
  ? [
      Credentials({
        id: "development",
        name: "Development",
        credentials: { email: { label: "Email", type: "email" } },
        authorize(credentials) {
          const email = typeof credentials?.email === "string" ? credentials.email : null;
          // The allow-list still decides. A local sign-in is a shortcut past
          // Google, never past the two-account rule.
          if (email === null || !isAllowed(email, householdAllowList())) return null;
          return { id: email, email };
        },
      }),
    ]
  : [];

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  session: { strategy: "jwt" },
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID ?? "",
      clientSecret: process.env.AUTH_GOOGLE_SECRET ?? "",
    }),
    ...developmentProviders,
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
