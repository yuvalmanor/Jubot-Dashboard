import { defineConfig } from "vitest/config";

// The domain suite is plain data in, plain data out (ADR 0004). It runs in a bare
// node environment on purpose: no database, no browser, no network.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/domain/**/*.test.ts"],
  },
});
