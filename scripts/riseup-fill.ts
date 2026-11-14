/**
 * Reading one month out of RiseUp and folding it into the מאזן's rows.
 *
 *   npm run riseup:fill -- yuval                 # the last ended cashflow month
 *   npm run riseup:fill -- yuval 2026-10         # that month
 *   npm run riseup:fill -- yuval 2026-10..2026-11      # month by month
 *   npm run riseup:fill -- yuval --from <saved.json>   # a response already on disk
 *   npm run riseup:fill -- yuval 2026-10 --no-db       # fold only, no comparison
 *   npm run riseup:fill -- yuval 2026-10 --write --approve <token>
 *   npm run riseup:fill -- yuval 2026-10 --write --approve <token> --decline 3,7
 *
 * **It reports unless it is told to write.** With `DATABASE_URL` set it prints the
 * side-by-side — one line per Personal Category, what the מאזן holds, what RiseUp
 * says, the difference — and a token over the lines it is offering. Nothing is
 * written until that token comes back with `--write --approve`, which is ADR 0006's
 * "nothing is written without a person approving it, line by line". A figure RiseUp
 * revises changes the token, so an approval is an approval of the lines it was
 * printed with and never of a month that has moved since.
 *
 * The write goes through `saveMonthEntries` and nowhere else: one transaction per
 * month, only the lines approved, never a `null` amount — so a category RiseUp was
 * silent about keeps its blank and `monthClosure` reads the month exactly as it did
 * before the run. Nothing closes a month and nothing touches `rate_watch_items`.
 *
 * The comparison *and* the write are refused for a month before 2026-10, where the
 * sheet importer is the authority; folding such a month and printing its totals
 * stays allowed, and is how the two months the household had already copied by hand
 * were used to prove the rules.
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

import { saveMonthEntries } from "@/db/ledger";
import {
  type HeldCategory,
  type RiseUpComparison,
  compareWithLedger,
} from "@/domain/import/riseup-compare";
import { RiseUpCutoverError, isRiseUpAuthority } from "@/domain/import/riseup-cutover";
import {
  type RiseUpFold,
  type RiseUpMapping,
  type RiseUpMonth,
  expenseTotals,
  foldRiseUpMonth,
} from "@/domain/import/riseup-fold";
import {
  type RiseUpWritePlan,
  approvalToken,
  categoryKey,
  planRiseUpWrite,
} from "@/domain/import/riseup-write";
import { type Money, isCurrency, money, toDecimalString } from "@/domain/money/money";
import {
  type CalendarMonth,
  monthKey,
  monthRange,
  parseMonthKey,
} from "@/domain/time/calendar-month";

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
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly retired: boolean;
  readonly amount_minor: string | null;
  readonly currency: string | null;
}

/**
 * That Person's Personal Categories, each with whatever `entries` holds for this
 * month, and each with its own id — which is what a write points at.
 * **Every statement here is a `select`.**
 *
 * It reads all of them, not only the ones with an Entry, because "does this
 * category exist at all" is what separates a new row from a figure with nowhere
 * to land — and the monthly run never creates a category.
 */
async function heldCategories(
  personId: string,
  month: CalendarMonth,
  connectionString: string,
): Promise<{ held: HeldCategory[]; ids: Map<string, string>; host: string }> {
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString);
  const client = new pg.Client({
    connectionString,
    ssl: local ? false : { rejectUnauthorized: true },
  });
  await client.connect();
  try {
    const rows = (
      await client.query<HeldRow>(
        `select c.id::text                               as id,
                c.name                                   as name,
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

    const held = rows.map((row): HeldCategory => {
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
    });

    /**
     * The id a write points at, keyed the way the comparison keys a row. Two
     * Personal Categories of one Person sharing a name *and* a type — a retired
     * one beside its live replacement, say — would collapse into one row in the
     * comparison and into one id here, and the figure would land in whichever of
     * them the query happened to return second. That is a refusal: which one the
     * household meant is theirs to settle in `/balance`, by renaming one.
     */
    const ids = new Map<string, string>();
    for (const row of rows) {
      if (row.type !== "income" && row.type !== "expense") continue;
      const key = categoryKey(row.name, row.type);
      const already = ids.get(key);
      if (already !== undefined) {
        throw new Error(
          `${personId} has two Personal Categories named \`${row.name}\` of the same סוג ` +
            `(\`${already}\` and \`${row.id}\`), so a figure for it has two places it could ` +
            `land and this run will not choose between them. Rename one in /balance.`,
        );
      }
      ids.set(key, row.id);
    }

    return { host: new URL(connectionString).host, ids, held };
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
  closing: () => void,
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
  closing();
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

// --- the write ---------------------------------------------------------------

/**
 * What a write is offered, approved and refused, said in the report.
 *
 * The token is printed whether or not `--write` was passed, because the ordinary
 * loop is two runs: one that reads the month and prints the table, and one that
 * approves it. Nothing is written by the first.
 */
function reportWrite(
  plan: RiseUpWritePlan,
  person: string,
  month: string,
  host: string | null,
  state: { readonly writing: boolean; readonly written: number | null },
): void {
  say(`## The write`);
  say();

  if (plan.offered.length > 0) {
    say(`| # | קטגוריה אישית | סוג | מאזן | RiseUp | הפרש |`);
    say(`| ---: | --- | --- | ---: | ---: | ---: |`);
    for (const line of plan.offered) {
      say(
        `| ${line.index} | ${line.personalCategory} | ${line.type === "income" ? "הכנסה" : "הוצאה"} ` +
          `| ${line.jubot === null ? "*not recorded*" : shekels(line.jubot)} ` +
          `| ${shekels(line.riseUp)} | ${line.difference === null ? "*new*" : shekels(line.difference)} |`,
      );
    }
    say();
  }

  if (plan.declined.length > 0) {
    say(
      `**Skipped** by \`--decline\`: ${plan.declined
        .map((line) => `${line.index} ${line.personalCategory} (${shekels(line.riseUp)})`)
        .join("; ")} — not written, and the מאזן keeps whatever it already holds ` +
        `${plan.declined.length === 1 ? "for it" : "for them"}.`,
    );
    say();
  }

  if (plan.refusals.length > 0) {
    say(state.writing ? `**Nothing was written.**` : `**Nothing written** — this run reports.`);
    say();
    for (const refusal of plan.refusals) say(`- ${refusal}`);
    say();
    if (plan.offered.length > 0 && plan.awaitingApproval) {
      say(`To write ${plan.offered.length === 1 ? "it" : "them"}:`);
      say();
      say("```bash");
      say(`npm run riseup:fill -- ${person} ${month} --write --approve ${plan.token}`);
      say("```");
      say();
      say(
        `Add \`--decline <n>\` — the numbers in the table above, comma-separated — for a line ` +
          `the household does not want written. A figure RiseUp revises changes the token, so ` +
          `an approval is an approval of the lines it was printed with.`,
      );
      say();
    }
    return;
  }

  if (plan.offered.length === 0) {
    say(
      `**Nothing to write.** No line differs and none is new, so there is nothing to approve ` +
        `and no Entry was touched. A month that already agrees writes nothing — including on a ` +
        `run that passed \`--write\`.`,
    );
    say();
    return;
  }

  if (state.written === null || state.written === 0) {
    say(
      state.written === 0
        ? `**Nothing to write.** Every line offered was declined, so no Entry was touched and ` +
            `the month stands as it did.`
        : `Nothing written: this run reports. The ${plan.offered.length === 1 ? "line" : "lines"} ` +
            `above ${plan.offered.length === 1 ? "is" : "are"} approved by ` +
            `\`--write --approve ${plan.token}\`.`,
    );
    say();
    return;
  }

  say(
    `**Written.** ${state.written} ${state.written === 1 ? "Entry" : "Entries"} saved to ` +
      `\`${host ?? "the ledger"}\` for ${month}, in one transaction, as whole shekels: ` +
      `${plan.approved.map((entry) => `${entry.personalCategory} ${shekels(entry.amount)}`).join("; ")}.`,
  );
  say();
  say(
    `No month was closed and no blank was filled: a category RiseUp was silent about keeps its ` +
      `blank, so \`monthClosure\` reads this month exactly as it did before the run. ` +
      `\`rate_watch_items\` was not touched — the מאזן is all this writes.`,
  );
  say();
  say(`The grid reads it at \`/balance\` and \`/balance/month?month=${month}\`.`);
  say();
}

// --- the run -----------------------------------------------------------------

const args = process.argv.slice(2);
const flagValue = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
};
/** Every occurrence, because `--approve` and `--decline` are given per month. */
const flagValues = (name: string): string[] =>
  args.flatMap((arg, index) => (arg === name ? [args[index + 1] ?? ""] : []));
const positional = args.filter((arg, index) => {
  if (arg.startsWith("--")) return false;
  const previous = args[index - 1];
  return previous === undefined || !previous.startsWith("--");
});

const usage =
  "Usage: npm run riseup:fill -- <person> [YYYY-MM | YYYY-MM..YYYY-MM] [--from <saved.json>]\n" +
  "                              [--config <path>] [--no-db]\n" +
  "                              [--write --approve <token> [--decline <n>[,<n>]]]\n" +
  `  <person> is one of ${PEOPLE.map((p) => p.id).join(", ")}.\n` +
  "  Without a month, RiseUp's own `previous` — the last ended cashflow month.\n" +
  "  A range runs month by month, each fetched, compared and approved on its own.\n" +
  "  --no-db folds and prints without reading the ledger at all.\n" +
  "  --write writes the lines the printed token approves, and nothing else.\n" +
  "  --decline takes the line numbers the write offered; prefix them with\n" +
  "  `YYYY-MM:` when the run covers more than one month.";

const personId = positional[0];
if (personId === undefined) throw new Error(usage);

const found = PEOPLE.find((candidate) => candidate.id === personId);
if (found === undefined) {
  throw new Error(
    `\`${personId}\` is not one of the household's two People (${PEOPLE.map((p) => p.id).join(", ")}).\n${usage}`,
  );
}
/** Bound to a name of its own so that `runMonth` reads it as the Person it is. */
const person = found;

const MONTH = /^\d{4}-\d{2}$/;
const RANGE = /^(\d{4}-\d{2})\.\.(\d{4}-\d{2})$/;

/**
 * The months this run covers, as RiseUp's own `date` argument takes them. A range
 * is a list, run one at a time; `previous` resolves inside RiseUp, so it stays
 * the string it is.
 */
function datesOf(argument: string | undefined): string[] {
  if (argument === undefined) return ["previous"];
  if (MONTH.test(argument)) return [argument];
  const range = RANGE.exec(argument);
  if (range === null) {
    throw new Error(
      `\`${argument}\` is not a month. Write it as YYYY-MM, or YYYY-MM..YYYY-MM for a range.\n${usage}`,
    );
  }
  const [, first = "", last = ""] = range;
  const months = monthRange(parseMonthKey(first), parseMonthKey(last));
  if (months.length === 0) {
    throw new Error(`\`${argument}\` runs backwards: ${first} is after ${last}.\n${usage}`);
  }
  return months.map(monthKey);
}

const dates = datesOf(positional[1]);

const from = flagValue("--from");
const configPath = flagValue("--config") ?? configPathDefault();
const writing = args.includes("--write");
const approvals = flagValues("--approve").filter((token) => token.length > 0);

/**
 * The declined line numbers, per month. A bare number belongs to the one month a
 * run covers; across a range it has to say which month it means, because line 2
 * of October and line 2 of November are different lines.
 *
 * Numbers rather than names on purpose: `חו"ל` and `שכ"ד` both carry a double
 * quote, and a quote in an argument is exactly what `/balance/import`'s own
 * comment records going wrong.
 */
const declines = new Map<string, number[]>();
for (const raw of flagValues("--decline")) {
  for (const piece of raw.split(",").map((part) => part.trim()).filter((part) => part.length > 0)) {
    const [left = "", right] = piece.split(":");
    const scope = right === undefined ? null : left;
    const number = Number(right === undefined ? left : right);
    if (!Number.isInteger(number) || number < 1) {
      throw new Error(
        `\`${piece}\` is not a line number. --decline takes the numbers in the write's own ` +
          `table, comma-separated, each optionally prefixed with \`YYYY-MM:\`.\n${usage}`,
      );
    }
    if (scope === null && dates.length > 1) {
      throw new Error(
        `This run covers ${dates.length} months, so \`--decline ${piece}\` is ambiguous: line ` +
          `${number} of which month? Write it as \`--decline <YYYY-MM>:${number}\`.\n${usage}`,
      );
    }
    if (scope !== null && !MONTH.test(scope)) {
      throw new Error(`\`${scope}\` is not a month in \`--decline ${piece}\`.\n${usage}`);
    }
    const key = scope ?? "*";
    declines.set(key, [...(declines.get(key) ?? []), number]);
  }
}

if (from !== undefined && dates.length > 1) {
  throw new Error(
    `\`--from\` carries one saved month, so it cannot answer a range of ${dates.length}. Run the ` +
      `months one at a time, or drop \`--from\` and let the script fetch each of them.\n${usage}`,
  );
}

const noDb = args.includes("--no-db");
if (writing && noDb) {
  throw new Error(
    "`--write` writes from the side-by-side, and `--no-db` is what refuses to read it. Nothing " +
      "is written over a ledger nobody looked at.",
  );
}

const connectionString = process.env.DATABASE_URL ?? "";
if (writing && connectionString.length === 0) {
  throw new Error(
    "`DATABASE_URL` is not set, so there is no ledger to write to. `.env.production.local` is " +
      "where the household's lives.",
  );
}

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

/** One month: read it, fold it, compare it, and write it if it was approved. */
async function runMonth(date: string): Promise<void> {
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
   * The cutover is keyed on the month the fold actually covers, not on the
   * argument: `previous` resolves inside RiseUp and `--from` carries whatever
   * month was saved. Decided before any connection is opened.
   */
  let compared: { comparison: RiseUpComparison; ids: Map<string, string>; host: string } | null = null;
  let noComparison: string[] | null = null;

  if (noDb) {
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
      const { held, ids, host } = await heldCategories(person.id, fold.month, connectionString);
      compared = {
        comparison: compareWithLedger(fold.totals, held, fold.month, {
          unresolved: fold.unresolved.length,
        }),
        ids,
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

  let plan: RiseUpWritePlan | null = null;
  let written: number | null = null;
  let writeFailure: string | null = null;

  if (compared !== null) {
    const declined = [...(declines.get(monthKey(fold.month)) ?? []), ...(declines.get("*") ?? [])];
    const token = approvalToken(person.id, compared.comparison);
    // Across a range each month carries its own token, so the one that matches
    // this month is the approval of it. With none matching, the first is passed
    // through so that the refusal names what was offered instead of pretending
    // nothing was confirmed at all.
    const approve = approvals.includes(token) ? token : approvals[0];
    plan = planRiseUpWrite(person.id, compared.comparison, {
      ids: compared.ids,
      declined,
      ...(writing && approve !== undefined ? { approve } : {}),
    });

    if (writing && plan.writable) {
      if (plan.approved.length === 0) {
        written = 0;
      } else {
        try {
          // One transaction for the month, through the one door into `entries`
          // (ADR 0006). A failure leaves the month exactly as it was.
          await saveMonthEntries(
            fold.month,
            plan.approved.map((entry) => ({
              personalCategoryId: entry.personalCategoryId,
              amount: entry.amount,
            })),
          );
          written = plan.approved.length;
        } catch (cause) {
          writeFailure = (cause as Error).message;
        }
      }
    }
  }

  report(
    fold,
    source,
    savedTo,
    () => {
      if (compared !== null) {
        reportComparison(compared.comparison, compared.host, person.id);
      } else if (noComparison !== null) {
        reportNoComparison(noComparison);
      }
    },
    () => {
      if (plan === null) {
        say(`## The write`);
        say();
        say(
          `Nothing written, and nothing could be: there is no side-by-side to write from. A ` +
            `write takes the ledger's own figures beside RiseUp's and the household's approval ` +
            `of the difference (ADR 0006).`,
        );
        say();
        return;
      }
      if (writeFailure !== null) {
        say(`## The write`);
        say();
        say(`**The write failed and nothing was written**: ${writeFailure}`);
        say();
        say(
          `The month is as it was: one transaction covers it, so a failure part-way through ` +
            `leaves no half-written month behind.`,
        );
        say();
        return;
      }
      reportWrite(plan, person.id, monthKey(fold.month), compared === null ? null : compared.host, {
        writing,
        written,
      });
    },
  );
}

for (const date of dates) {
  if (out.length > 0) {
    say();
    say(`---`);
    say();
  }
  await runMonth(date);
}

process.stdout.write(`${out.join("\n")}\n`);
// The MCP server is a child process with a shell between us and it; nothing is
// left to wait for once the report is out.
process.exit(0);
