import { redirect } from "next/navigation";

import { auth, householdAllowList } from "@/auth";
import { isAllowed } from "@/domain/access/allow-list";

/**
 * Defence in depth. The middleware already redirected an unsigned-in visitor and
 * the allow-list already refused an unknown address at sign-in; every page and
 * every server action checks again here, so no route and no write can run for an
 * address that is not one of the two.
 */
export async function requireHouseholdEmail(): Promise<string> {
  const session = await auth();
  const email = session?.user?.email;
  if (session === null || typeof email !== "string" || !isAllowed(email, householdAllowList())) {
    redirect("/signin");
  }
  return email;
}
