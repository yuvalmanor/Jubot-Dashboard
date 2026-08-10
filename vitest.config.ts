import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// The domain suite is plain data in, plain data out (ADR 0004). It runs in a bare
// node environment on purpose: no database, no browser, no network.
//
// The `@/` alias mirrors tsconfig's paths, so a domain module imports a sibling
// the same way under vitest as it does under Next.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/domain/**/*.test.ts"],
  },
});
