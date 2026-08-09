import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * ADR 0004: domain modules import nothing from Next.js, React or the database
 * client. This is the guard that keeps the rule from eroding one import at a time.
 */

const DOMAIN_ROOT = fileURLToPath(new URL(".", import.meta.url));

const FORBIDDEN = [/^next(\/|$)/, /^next-auth(\/|$)/, /^react(\/|$)/, /^react-dom(\/|$)/, /^pg(\/|$)/];

const IMPORT_PATTERN = /(?:from\s+|import\s+|require\()\s*["']([^"']+)["']/g;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
    return [path];
  });
}

describe("domain modules are framework-free", () => {
  const files = sourceFiles(DOMAIN_ROOT);

  it("finds domain modules to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s imports no framework or database code", (file) => {
    const source = readFileSync(file, "utf8");
    const specifiers = [...source.matchAll(IMPORT_PATTERN)].map((match) => match[1] ?? "");
    const offenders = specifiers.filter((specifier) =>
      FORBIDDEN.some((forbidden) => forbidden.test(specifier)),
    );
    expect(offenders).toEqual([]);
  });
});
