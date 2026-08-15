import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Resolves TypeScript's module specifiers for plain `node`.
 *
 * Next and Vitest both read the `@/…` alias out of tsconfig and both let an
 * import omit its extension; node does neither. A script that wants the real
 * domain modules — rather than a second copy of their rules — needs both, since
 * `@/db/import` reaches on into `./client`. Node transforms the types itself
 * once a specifier resolves, so the hook only has to find the file.
 */

const source = new URL("../src/", import.meta.url);

/** TypeScript imports carry no extension; these are what one may mean. */
const CANDIDATES = [".ts", ".tsx", "/index.ts", "/index.tsx"];

function firstThatExists(base) {
  for (const suffix of CANDIDATES) {
    const candidate = new URL(base.href + suffix);
    if (existsSync(fileURLToPath(candidate))) return candidate.href;
  }
  return null;
}

export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) {
    const resolved = firstThatExists(new URL(specifier.slice(2), source));
    if (resolved === null) {
      throw new Error(`Cannot resolve ${specifier} under ${fileURLToPath(source)}`);
    }
    return next(resolved, context);
  }

  // A relative import inside src, written without its extension.
  if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
    const resolved = firstThatExists(new URL(specifier, context.parentURL));
    if (resolved !== null) return next(resolved, context);
  }

  return next(specifier, context);
}
