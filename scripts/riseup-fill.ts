/**
 * Reading one month out of RiseUp and folding it into the מאזן's rows.
 *
 *   npm run riseup:fill -- yuval                 # the last ended cashflow month
 *   npm run riseup:fill -- yuval 2026-10         # that month
 *   npm run riseup:fill -- yuval --from <saved.json>   # a response already on disk
 *   npm run riseup:fill -- yuval 2026-10 --no-db       # fold only, no comparison
 *
 * It **reports**, like `sheet-refresh.ts`. Every statement it sends is a `select`:
 * nothing here writes an Entry and nothing here closes a month. Phase 33 adds the
 * write (see `plans/riseup-fill.md`).
 *
 * With `DATABASE_URL` set it also prints the side-by-side — one line per Personal
 * Category, what the מאזן holds, what RiseUp says, the difference — which is what
 * ADR 0006 makes the precondition of any write. The comparison is refused for a
 * month before 2026-10, where the sheet importer is the authority; folding such a
 * month and printing its totals stays allowed, and is how the two months the
 * household had already copied by hand were used to prove the rules.
 *
 * This script is the MCP client. It launches that Person's RiseUp server itself
 * and calls `get_budget`, so **no figure passes through a model** on its way into
 * the ledger — which is the whole point of ADR 0006's "the arithmetic is a pure,
 * tested module". The arithmetic is `src/domain/import/riseup-fold.ts`; this is
 * the shell around it: fetch, save, fold, print.
 *
 * The token is read from the MCP configuration — `mcpServers.<server>.env.RISEUP_PAT`
 * in the user's `~/.claude.json` — for the server that Person's row names. It is
 * never printed, never logged, never written into the repository and never passed
 * on a command line. `--config <path>` points the lookup somewhere else, which is
 * how "an unconfigured Person stops the run" is checked without editing the real
 * configuration.
 *
 * Each Person is reached through their own server and there is no fallback: Yuval's
 * spending written into Eden's categories would look entirely plausible and be
 * entirely wrong.
 *
 * The response is saved **outside the repository** — one month is 70–90,000
 * characters of someone's real spending — and the path is printed so a re-run can
 * use `--from`.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import pg from "pg";

import {
  type HeldCategory,
  type RiseUpComparison,
  RiseUpCutoverError,
  compareWithLedger,
  isRiseUpAuthority,
} from "@/domain/import/riseup-compare";
import {
  type RiseUpFold,
  type RiseUpMapping,
  type RiseUpMonth,
  expenseTotals,
  foldRiseUpMonth,
} from "@/domain/import/riseup-fold";
import { type Money, isCurrency, money, toDecimalString } from "@/domain/money/money";
import { type CalendarMonth, monthKey } from "@/domain/time/calendar-month";

const CURRENCY = "ILS" as const;

/**
 * One Person, one account, one server — the token lives in the server, so "per
 * Person" resolves to a server rather than to a parameter.
 */
const PEOPLE = [
  { id: "yuval", server: "riseup" },
  { id: "eden", server: "riseup-eden" },
] as const;

type PersonId = (typeof PEOPLE)[number]["id"];

const MAPPING_PATH = (person: string) => `docs/source/riseup-${person}.json`;

// --- the token, which never leaves this file ---------------------------------

interface McpConfig {
  readonly mcpServers?: Record<string, { readonly env?: Record<string, string> }>;
}

function configPathDefault(): string {
  return join(homedir(), ".claude.json");
}

/**
 * That server's `RISEUP_PAT`. Absent, the run stops here and names the entry to
 * add — it never reaches for the other Person's account.
 */
function tokenFor(server: string, configPath: string): string {
  let config: McpConfig;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8")) as McpConfig;
  } catch {
    throw new Error(
      `The MCP configuration at ${configPath} could not be read, so RiseUp's token for ` +
        `\`${server}\` cannot be found. Pass --config <path> if it lives elsewhere.`,
    );
  }
  const token = config.mcpServers?.[server]?.env?.RISEUP_PAT;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error(
      `RiseUp's MCP server \`${server}\` is not configured, so this month cannot be fetched.\n` +
        `Add this to \`mcpServers\` in ${configPath}:\n\n` +
        `  "${server}": {\n` +
        `    "command": "npx",\n` +
        `    "args": ["-y", "@riseup-oss/mcp"],\n` +
        `    "env": { "RISEUP_PAT": "<that Person's RiseUp token>" }\n` +
        `  }\n\n` +
        `Nothing falls back to the other Person's account.`,
    );
  }
  return token;
}

// --- the MCP client ----------------------------------------------------------

/**
 * Shut the server down, all of it. On Windows there is a `cmd.exe` between us and
 * `npx`, and `kill()` kills only the shell — which leaves one `@riseup-oss/mcp`
 * holding a RiseUp token alive per run, as a process list after six runs shows.
 * The whole tree has to go.
 */
function stop(child: ChildProcess): void {
  child.stdin?.end();
  if (process.platform === "win32" && child.pid !== undefined) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    return;
  }
  child.kill();
}

interface JsonRpcMessage {
  readonly id?: number | string;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

/**
 * `get_budget` for one month, over stdio, against the server the household
 * already configured — `@riseup-oss/mcp`, `budget:read` and nothing else.
 */
async function fetchBudget(server: string, date: string, configPath: string): Promise<unknown> {
  const token = tokenFor(server, configPath);
  const redact = (text: string) => text.split(token).join("[the token]");

  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const child = spawn(command, ["-y", "@riseup-oss/mcp"], {
    // The token goes in the environment, never in the arguments, so it cannot
    // appear in a process list.
    env: { ...process.env, RISEUP_PAT: token },
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
  let stderr = "";
  let buffer = "";
  let nextId = 1;

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-4000);
  });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length === 0) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue; // Not a JSON-RPC frame. The server's own chatter.
      }
      if (typeof message.id !== "number") continue;
      const slot = waiting.get(message.id);
      if (slot === undefined) continue;
      waiting.delete(message.id);
      if (message.error !== undefined) {
        slot.reject(new Error(redact(message.error.message ?? "the RiseUp server refused the call")));
      } else {
        slot.resolve(message.result);
      }
    }
  });

  const died = new Promise<never>((_, reject) => {
    child.on("error", (cause: Error) => {
      reject(new Error(`The RiseUp MCP server could not be started (${redact(cause.message)}).`));
    });
    child.on("exit", (code) => {
      reject(
        new Error(
          `The RiseUp MCP server exited (code ${code ?? "unknown"}) before answering.` +
            (stderr.length > 0 ? `\n${redact(stderr)}` : ""),
        ),
      );
    });
  });

  const send = (method: string, params: unknown, expectReply: boolean): Promise<unknown> => {
    const id = nextId++;
    const frame = expectReply
      ? { jsonrpc: "2.0", id, method, params }
      : { jsonrpc: "2.0", method, params };
    child.stdin.write(`${JSON.stringify(frame)}\n`);
    if (!expectReply) return Promise.resolve(undefined);
    return new Promise<unknown>((resolve, reject) => {
      waiting.set(id, { resolve, reject });
    });
  };

  const withTimeout = <T>(work: Promise<T>, seconds: number, what: string): Promise<T> => {
    let timer: NodeJS.Timeout;
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`RiseUp did not answer ${what} within ${seconds}s.`)), seconds * 1000);
    });
    return Promise.race([work, expiry, died]).finally(() => clearTimeout(timer)) as Promise<T>;
  };

  try {
    await withTimeout(
      send(
        "initialize",
        {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "jubot-riseup-fill", version: "1" },
        },
        true,
      ),
      90,
      "the handshake",
    );
    await send("notifications/initialized", {}, false);

    const result = (await withTimeout(
      send("tools/call", { name: "get_budget", arguments: { date } }, true),
      120,
      `get_budget for ${date}`,
    )) as {
      readonly isError?: boolean;
      readonly content?: readonly { readonly type?: string; readonly text?: string }[];
    };

    const text = result.content?.find((part) => part.type === "text")?.text;
    if (typeof text !== "string" || text.length === 0) {
      throw new Error("RiseUp answered get_budget with no text content.");
    }
    if (result.isError === true) {
      throw new Error(`RiseUp refused get_budget: ${redact(text)}`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`RiseUp's answer to get_budget was not JSON: ${redact(text.slice(0, 300))}`);
    }
  } finally {
    stop(child);
  }
}

// --- what the מאזן already holds --------------------------------------------

interface HeldRow extends Record<string, unknown> {
  readonly name: string;
  readonly type: string;
  readonly retired: boolean;
  readonly amount_minor: string | null;
  readonly currency: string | null;
}

/**
 * That Person's Personal Categories, each with whatever `entries` holds for this
 * month. **Every statement here is a `select`.**
 *
 * It reads all of them, not only the ones with an Entry, because "does this
 * category exist at all" is what separates a new row from a figure with nowhere
 * to land — and the monthly run never creates a category.
 */
async function heldCategories(
  personId: string,
  month: CalendarMonth,
  connectionString: string,
): Promise<{ held: HeldCategory[]; host: string }> {
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString);
  const client = new pg.Client({
    connectionString,
    ssl: local ? false : { rejectUnauthorized: true },
  });
  await client.connect();
  try {
    const rows = (
      await client.query<HeldRow>(
        `select c.name                                   as name,
                c.type                                   as type,
                (c.active_until is not null)             as retired,
                e.amount_minor::text                     as amount_minor,
                e.currency                               as currency
           from personal_categories c
           left join entries e
             on e.personal_category_id = c.id
            and e.year  = $2
            and e.month = $3
          where c.person_id = $1`,
        [personId, month.year, month.month],
      )
    ).rows;

    return {
      host: new URL(connectionString).host,
      held: rows.map((row) => {
        if (row.type !== "income" && row.type !== "expense") {
          throw new Error(`\`${row.name}\` has the unknown Category Type \`${row.type}\`.`);
        }
        if (row.amount_minor === null) {
          return { personalCategory: row.name, type: row.type, amount: null, retired: row.retired };
        }
        const minorUnits = Number(row.amount_minor);
        if (!Number.isSafeInteger(minorUnits) || !isCurrency(row.currency)) {
          throw new Error(
            `The Entry for \`${row.name}\` in ${monthKey(month)} is malformed ` +
              `(${row.amount_minor} ${row.currency ?? "—"}).`,
          );
        }
        return {
          personalCategory: row.name,
          type: row.type,
          amount: money(minorUnits, row.currency),
          retired: row.retired,
        };
      }),
    };
  } finally {
    await client.end();
  }
}

// --- the report --------------------------------------------------------------

const out: string[] = [];
const say = (line = "") => out.push(line);

/** Whole shekels, grouped, the way the app and the sheet both show a figure. */
function shekels(amount: Money): string {
  const decimal = toDecimalString(amount);
  const [whole = "0", fraction = "00"] = decimal.split(".");
  const negative = whole.startsWith("-");
  const digits = negative ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const exact = fraction === "00" ? "" : `.${fraction}`;
  return `${negative ? "−" : ""}${grouped}${exact}`;
}

function report(
  fold: RiseUpFold,
  source: string,
  savedTo: string | null,
  sideBySide: () => void,
): void {
  say(`# RiseUp → מאזן: ${fold.person}, ${monthKey(fold.month)}`);
  say();
  say(`- Month RiseUp resolved: **${fold.budgetDate}** (a cashflow month need not start on the 1st)`);
  say(`- Cashflow last updated: ${fold.lastUpdatedAt ?? "not stated"}`);
  say(`- Read from: ${source}`);
  if (savedTo !== null) say(`- Response saved outside the repository: \`${savedTo}\``);
  say();

  say(`## One amount per Personal Category`);
  say();
  say(`Each RiseUp line is rounded to the shekel on its own, then added — which is what the`);
  say(`app displays and what the hand-copy wrote. A category no RiseUp line fed reads *not`);
  say(`recorded*, never 0.`);
  say();
  say(`| קטגוריה אישית | סוג | סכום | from |`);
  say(`| --- | --- | ---: | --- |`);
  for (const total of fold.totals) {
    const lines = total.lines
      .map((line) => {
        // Netting first, rounding after — so a netted line shows its gross, the
        // credit that came off it, and only then the figure.
        // A credit netted into a category that held no charge of its own is the
        // whole line; there is no gross to show it coming off.
        const netting =
          line.credits.length === 0 || line.gross.minorUnits === 0
            ? ""
            : ` ${shekels(line.gross)}${line.credits
                .map((credit) => ` − ${shekels(credit.amount)} (${credit.merchant})`)
                .join("")} =`;
        return line.exact.minorUnits === line.rounded.minorUnits
          ? `${line.label}${netting} ${shekels(line.rounded)}`
          : `${line.label}${netting} ${shekels(line.exact)} → ${shekels(line.rounded)}`;
      })
      .join("; ");
    const amount = total.amount === null ? "*not recorded*" : `**${shekels(total.amount)}**`;
    const from = total.lines.length === 0 ? (total.handTyped ? "hand-typed" : "—") : lines;
    say(`| ${total.personalCategory} | ${total.type === "income" ? "הכנסה" : "הוצאה"} | ${amount} | ${from} |`);
  }
  say();

  const expenses = expenseTotals(fold);
  const income = fold.totals.filter((total) => total.type === "income" && total.amount !== null);
  say(
    `Expense rows recorded: **${shekels(expenses.recorded)}**` +
      (expenses.unresolved.minorUnits === 0
        ? ""
        : ` · still unresolved: ${shekels(expenses.unresolved)} · together: **${shekels(expenses.together)}**`),
  );
  say();
  for (const total of income) {
    say(`Income (${total.personalCategory}): **${shekels(total.amount as Money)}**`);
  }
  if (income.length === 0) {
    say(
      `**No income.** No salary charge was found, so none is written — RiseUp's predicted ` +
        `salary is never substituted.`,
    );
    const excludedIn = fold.excluded.filter((row) => row.side === "income");
    if (excludedIn.length > 0) {
      say();
      say(
        `RiseUp holds ${excludedIn.length === 1 ? "one payment" : `${excludedIn.length} payments`} in as ` +
          `**excluded**, and excluded money reaches no total. If the salary is among them, the month is ` +
          `not tidied away yet:`,
      );
      for (const row of excludedIn) {
        say(`- ${row.label} — ${shekels(row.amount)} in${row.date === undefined ? "" : ` (${row.date})`}`);
      }
    }
    const credits = fold.unresolved.filter((row) => row.kind === "credit-without-disposition");
    if (credits.length > 0) {
      say();
      say(
        `${credits.length === 1 ? "One payment" : `${credits.length} payments`} in arrived outside the ` +
          `salary slot and ${credits.length === 1 ? "is" : "are"} listed under *Unresolved* below. A real ` +
          `earning among them is recorded with the \`income\` disposition rather than left unwritable.`,
      );
    }
  }
  say();

  say(`## Unresolved`);
  say();
  if (fold.unresolved.length === 0) {
    say(`Nothing. Every RiseUp row has a rule and every amount in has a disposition.`);
  } else {
    say(`Printed, and nothing here changes a figure. Together these are what blocks a write.`);
    say();
    say(`| מה | שם | סכום | id | פרטים |`);
    say(`| --- | --- | ---: | --- | --- |`);
    for (const row of fold.unresolved) {
      const id = row.sequenceId ?? row.transactionId ?? row.envelopeId ?? "—";
      const detail = [row.date, row.detail].filter((part) => part !== undefined).join(", ");
      say(`| ${row.kind} | ${row.label} | ${shekels(row.amount)} | \`${id}\` | ${detail || "—"} |`);
    }
  }
  say();

  if (fold.memos.length > 0) {
    say(`## Memos, written nowhere`);
    say();
    say(
      `These sit beside the מאזן's totals and reach no Personal Category at all. Reserve pay is ` +
        `the household's case: it has no row to go into and must not be given one.`,
    );
    say();
    for (const row of fold.memos) {
      const where = [row.date, row.note].filter((part) => part !== undefined).join(" — ");
      say(`- ${row.label} — ${shekels(row.amount)} in${where === "" ? "" : ` (${where})`}`);
    }
    say();
  }

  if (fold.silenced.length > 0) {
    say(`## Silent by decision`);
    say();
    for (const row of fold.silenced) say(`- ${row.label} — ${shekels(row.amount)} — ${row.why}`);
    say();
  }

  say(`## Still waiting for charges`);
  say();
  if (fold.waiting.length === 0) {
    say(`None. RiseUp has stopped waiting for every category this month.`);
  } else {
    say(`RiseUp has not stopped waiting for these, so their figures may still move. The run`);
    say(`proceeds on the household's say-so rather than refusing.`);
    say();
    for (const row of fold.waiting) say(`- ${row.label} — waits until ${row.balanceDate}`);
  }
  say();

  say(`## Excluded, and therefore counted nowhere`);
  say();
  if (fold.excluded.length === 0) {
    say(`Nothing excluded this month.`);
  } else {
    for (const row of fold.excluded) {
      say(`- ${row.label} — ${shekels(row.amount)} ${row.side === "income" ? "in" : "out"}${row.date === undefined ? "" : ` (${row.date})`}`);
    }
  }
  say();

  sideBySide();

  say(`## Nothing written`);
  say();
  say(`This phase reports only: no Entry is written, no month is closed, \`rate_watch_items\``);
  say(`is untouched. Every statement this script sends is a \`select\`. Phase 33 writes.`);
  if (fold.unresolved.length > 0) {
    say();
    say(
      `A write would be blocked by **${fold.unresolved.length}** unresolved ${fold.unresolved.length === 1 ? "row" : "rows"} above.`,
    );
  }
}

/**
 * The side-by-side. One line per Personal Category, what Jubot holds against what
 * RiseUp says, and the difference — which is what a person approves, line by line,
 * before anything is written (ADR 0006).
 */
function reportComparison(comparison: RiseUpComparison, host: string, person: string): void {
  say(`## מאזן against RiseUp`);
  say();
  say(`- Host: \`${host}\``);
  say(`- Month compared: **${monthKey(comparison.month)}**, ${person}'s Personal Categories only`);
  say();

  // The unresolved count comes first and overrides everything the table says.
  // Money RiseUp holds that reached no Personal Category is money this table is
  // short by, and a row reading *left alone* beside it may be left alone only
  // because its RiseUp line has no rule yet — so nothing here is offered for
  // approval until the count is nil.
  if (!comparison.approvable) {
    const parts = [
      comparison.unresolved > 0
        ? `**${comparison.unresolved}** unresolved ${comparison.unresolved === 1 ? "row" : "rows"} above`
        : null,
      comparison.blocked.length > 0
        ? `**${comparison.blocked.length}** ${comparison.blocked.length === 1 ? "figure" : "figures"} with no Personal Category to land in`
        : null,
    ].filter((part) => part !== null);
    say(
      `**Not approvable.** ${parts.join(" and ")} — so this table is incomplete by an amount ` +
        `nobody has placed, and a row below reading *left alone* may be left alone only because ` +
        `its RiseUp line has no rule yet. It is printed because the report is never refused; ` +
        `nothing in it may be written until the ${comparison.unresolved + comparison.blocked.length === 1 ? "row is" : "rows are"} resolved.`,
    );
    say();
    say(
      `Were they resolved, ${comparison.changes.length === 0 ? "**no line**" : `**${comparison.changes.length}** ${comparison.changes.length === 1 ? "line" : "lines"}`} ` +
        `would be offered: ${comparison.counts.differs} changed, ${comparison.counts.new} new. ` +
        `${comparison.counts.same} already agree; ${comparison.counts["left-alone"]} are left alone.`,
    );
    say();
  } else if (comparison.identical) {
    say(
      `**Nothing to approve.** ${comparison.counts.same} ${comparison.counts.same === 1 ? "row" : "rows"} ` +
        `already agree, ${comparison.counts["left-alone"]} are being left alone and ` +
        `${comparison.counts.blank} are blank on both sides — so a write would change nothing.`,
    );
    say();
  } else {
    say(
      `**${comparison.changes.length}** ${comparison.changes.length === 1 ? "line" : "lines"} would be ` +
        `offered for approval: ${comparison.counts.differs} changed, ${comparison.counts.new} new. ` +
        `${comparison.counts.same} already agree; ${comparison.counts["left-alone"]} are left alone.`,
    );
    say();
  }

  say(`| קטגוריה אישית | סוג | מאזן | RiseUp | הפרש | |`);
  say(`| --- | --- | ---: | ---: | ---: | --- |`);
  for (const row of comparison.rows) {
    const state =
      row.state === "same"
        ? "agrees"
        : row.state === "differs"
          ? "**differs**"
          : row.state === "new"
            ? "**new**"
            : row.state === "left-alone"
              ? `left alone${row.handTyped ? ", hand-typed" : ""}`
              : row.state === "blank"
                ? "neither"
                : "**no such Personal Category**";
    say(
      `| ${row.personalCategory}${row.retired ? " *(retired)*" : ""} ` +
        `| ${row.type === "income" ? "הכנסה" : "הוצאה"} ` +
        `| ${row.jubot === null ? "*not recorded*" : shekels(row.jubot)} ` +
        `| ${row.riseUp === null ? "*not recorded*" : shekels(row.riseUp)} ` +
        `| ${row.difference === null ? "—" : shekels(row.difference)} | ${state} |`,
    );
  }
  say();

  say(
    `*Left alone* is a row the מאזן holds that no RiseUp line fed — ordinarily because each ` +
      `Person's grid holds rows the other one actually pays, and three of Yuval's were typed as ` +
      `a literal 0. None of them is proposed as a zero and none counts as a difference. While ` +
      `anything above is unresolved, a row may also read *left alone* because the RiseUp line ` +
      `that would feed it has no rule yet, which is the other reason nothing here is approvable.`,
  );
  say();

  if (comparison.blocked.length > 0) {
    say(`### Nowhere to land`);
    say();
    say(
      `RiseUp has a figure for ${comparison.blocked.length === 1 ? "a Personal Category" : "Personal Categories"} ` +
        `${person} does not have. **This blocks the write**: the monthly run never creates a category — ` +
        `\`--map\` (Phase 34) proposes one and a person answers.`,
    );
    say();
    for (const row of comparison.blocked) {
      say(`- ${row.personalCategory} (${row.type === "income" ? "הכנסה" : "הוצאה"}) — ${shekels(row.riseUp as Money)}`);
    }
    say();
  }
}

/** Why there is no side-by-side, said in the report rather than thrown away. */
function reportNoComparison(why: readonly string[]): void {
  say(`## מאזן against RiseUp`);
  say();
  for (const line of why) say(line);
  say();
}

// --- the run -----------------------------------------------------------------

const args = process.argv.slice(2);
const flagValue = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
};
const positional = args.filter((arg, index) => {
  if (arg.startsWith("--")) return false;
  const previous = args[index - 1];
  return previous === undefined || !previous.startsWith("--");
});

const usage =
  "Usage: npm run riseup:fill -- <person> [YYYY-MM] [--from <saved.json>] [--config <path>] [--no-db]\n" +
  `  <person> is one of ${PEOPLE.map((p) => p.id).join(", ")}.\n` +
  "  Without a month, RiseUp's own `previous` — the last ended cashflow month.\n" +
  "  --no-db folds and prints without reading the ledger at all.";

const personId = positional[0];
if (personId === undefined) throw new Error(usage);

const person = PEOPLE.find((candidate) => candidate.id === personId);
if (person === undefined) {
  throw new Error(
    `\`${personId}\` is not one of the household's two People (${PEOPLE.map((p) => p.id).join(", ")}).\n${usage}`,
  );
}

const monthArgument = positional[1];
if (monthArgument !== undefined && !/^\d{4}-\d{2}$/.test(monthArgument)) {
  throw new Error(`\`${monthArgument}\` is not a month. Write it as YYYY-MM.\n${usage}`);
}
const date = monthArgument ?? "previous";

const from = flagValue("--from");
const configPath = flagValue("--config") ?? configPathDefault();

const mappingPath = MAPPING_PATH(person.id);
let mapping: RiseUpMapping;
try {
  mapping = JSON.parse(readFileSync(mappingPath, "utf8")) as RiseUpMapping;
} catch {
  throw new Error(
    `${person.id} has no mapping file at \`${mappingPath}\`, so there is no way to say which ` +
      `RiseUp row feeds which Personal Category. \`--map\` (Phase 34) proposes one.`,
  );
}
if (mapping.server !== person.server) {
  throw new Error(
    `\`${mappingPath}\` names the server \`${mapping.server}\`, but ${person.id}'s account is ` +
      `reached through \`${person.server}\`. One Person, one account: fix the file rather than the table.`,
  );
}

let raw: unknown;
let source: string;
let savedTo: string | null = null;

if (from !== undefined) {
  raw = JSON.parse(readFileSync(from, "utf8")) as unknown;
  source = `\`${from}\` (no network)`;
} else {
  raw = await fetchBudget(person.server, date, configPath);
  const directory = mkdtempSync(join(tmpdir(), "jubot-riseup-"));
  savedTo = join(directory, `${person.id}-${date}.json`);
  writeFileSync(savedTo, `${JSON.stringify(raw, null, 2)}\n`);
  source = `the \`${person.server}\` MCP server, \`get_budget\` for \`${date}\``;
}

const fold = foldRiseUpMonth(raw as RiseUpMonth, mapping, { currency: CURRENCY });

/**
 * The cutover is keyed on the month the fold actually covers, not on the argument:
 * `previous` resolves inside RiseUp and `--from` carries whatever month was saved.
 * Decided before any connection is opened.
 */
const connectionString = process.env.DATABASE_URL ?? "";
let comparison: { comparison: RiseUpComparison; host: string } | null = null;
let noComparison: string[] | null = null;

if (args.includes("--no-db")) {
  noComparison = ["`--no-db` was passed, so the ledger was not read and nothing is compared."];
} else if (connectionString.length === 0) {
  noComparison = [
    "`DATABASE_URL` is not set, so there is nothing to compare against. The fold above is all",
    "this run can say. Set it — `.env.production.local` is where the household's is — to get",
    "the side-by-side.",
  ];
} else if (!isRiseUpAuthority(fold.month)) {
  noComparison = [`**Refused.** ${new RiseUpCutoverError(fold.month).message}`];
} else {
  try {
    const { held, host } = await heldCategories(person.id, fold.month, connectionString);
    comparison = {
      comparison: compareWithLedger(fold.totals, held, fold.month, {
        unresolved: fold.unresolved.length,
      }),
      host,
    };
  } catch (cause) {
    // The fold is the expensive half and it is already in hand. A database that
    // cannot be reached must not take the report down with it.
    noComparison = [
      `**The ledger could not be read**, so nothing is compared: ${(cause as Error).message}`,
    ];
  }
}

report(fold, source, savedTo, () => {
  if (comparison !== null) {
    reportComparison(comparison.comparison, comparison.host, person.id);
  } else if (noComparison !== null) {
    reportNoComparison(noComparison);
  }
});

process.stdout.write(`${out.join("\n")}\n`);
// The MCP server is a child process with a shell between us and it; nothing is
// left to wait for once the report is out.
process.exit(0);
