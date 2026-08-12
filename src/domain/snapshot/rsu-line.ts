/**
 * How the RSU position becomes a line in מיפוי.
 *
 * Framework-free per ADR 0004.
 *
 * The sheet held the RSU holding in two places — the grant tables, and a
 * hardcoded figure in מיפוי converted at a hardcoded 3.602 — and the two drifted,
 * from each other and from the live rate. Nothing here can drift, because nothing
 * here is maintained:
 *
 * **The share count is never typed.** It is `RsuPosition.remainingShares` read as
 * of the snapshot's own date, which is itself derived from the grants, vests and
 * sales. There is no field for it and no form that offers one, so the two places
 * the sheet kept it are one place here.
 *
 * **The price is the one thing stated, and the snapshot owns it.** Nothing in this
 * system reads a market, so a price is a fact somebody records — recorded on the
 * snapshot, exactly like its exchange rate, so re-reading a snapshot from 2024
 * prices it at what a share cost in 2024.
 *
 * **The shekel figure goes through the snapshot's own rate.** Where the account is
 * held in another currency than the price is quoted in, the conversion is
 * `convertWithin` and can be nothing else: it is the only conversion path a
 * snapshot has, and it cannot reach today's rate. A snapshot with no rate for the
 * pair yields no figure rather than one converted at a rate nobody quoted.
 */

import { type Money, equals, subtract } from "@/domain/money/money";
import {
  type RsuHolding,
  type RsuPosition,
  type SharePrice,
  rsuHolding,
} from "@/domain/rsu/rsu-position";
import {
  type Account,
  type AccountStatement,
  type Snapshot,
  canConvertWithin,
  convertWithin,
  findAccount,
  findLine,
  isOpenOn,
} from "@/domain/snapshot/snapshot";

export type RsuLineReading =
  /** No account is named as carrying the position. The household does not track it in מיפוי. */
  | { readonly kind: "unnamed" }
  /** An account is named that no longer exists — surfaced, never treated as unnamed. */
  | { readonly kind: "unknown"; readonly accountId: string }
  /** The account is not open on this snapshot's date, so this snapshot holds no line for it. */
  | { readonly kind: "not-open"; readonly account: Account }
  /** Nobody stated a share price for this reading, so there is nothing to derive from. */
  | { readonly kind: "unpriced"; readonly account: Account; readonly shares: number }
  /** The snapshot carries no rate between the price's currency and the account's. */
  | {
      readonly kind: "unconvertible";
      readonly account: Account;
      readonly holding: RsuHolding;
    }
  | {
      readonly kind: "derived";
      readonly account: Account;
      readonly holding: RsuHolding;
      /** What the line must read, in the account's own currency. Derived, never typed. */
      readonly balance: Money;
      /** What the line does read, or `null` where the snapshot holds none yet. */
      readonly recorded: Money | null;
      /** `recorded − balance`. `null` when there is no recorded figure to differ. */
      readonly difference: Money | null;
      /** The recorded figure is the derived one. False when the position has moved since. */
      readonly agrees: boolean;
    };

/**
 * Read the RSU account's line as the position and the snapshot's own price say it
 * must be, beside whatever the snapshot currently records.
 *
 * `position` is read as of the snapshot's date, not today's: a snapshot of January
 * holds January's shares, and a sale made in March cannot reach back and reduce it.
 */
export function readRsuLine(input: {
  readonly snapshot: Snapshot;
  readonly accounts: readonly Account[];
  readonly accountId: string | null;
  readonly position: RsuPosition;
  readonly price: SharePrice | null;
}): RsuLineReading {
  const { snapshot, accountId, price } = input;
  if (accountId === null) return { kind: "unnamed" };

  const account = findAccount(input.accounts, accountId);
  if (account === undefined) return { kind: "unknown", accountId };

  // An account that had not opened by this date has no line here to derive into,
  // and writing one would put a holding into a snapshot taken before it existed.
  if (!isOpenOn(account, snapshot.takenOn)) return { kind: "not-open", account };

  const line = findLine(snapshot, account.id);
  if (price === null) {
    return { kind: "unpriced", account, shares: input.position.remainingShares };
  }

  const holding = rsuHolding(input.position, price);
  if (!canConvertWithin(snapshot, holding.value.currency, account.currency)) {
    return { kind: "unconvertible", account, holding };
  }

  const balance = convertWithin(snapshot, holding.value, account.currency);
  const recorded = line?.balance ?? null;

  return {
    kind: "derived",
    account,
    holding,
    balance,
    recorded,
    difference: recorded === null ? null : subtract(recorded, balance),
    agrees: recorded !== null && equals(recorded, balance),
  };
}

/**
 * The restatement a derived reading stands for, or `null` where there is nothing
 * to derive. Always `measured`: the figure was worked out from records and a price
 * somebody stated for this date, which is a measurement of exactly the kind the
 * flag means — it is not a figure that came forward from an earlier reading.
 */
export function rsuStatement(reading: RsuLineReading): AccountStatement | null {
  if (reading.kind !== "derived") return null;
  return { accountId: reading.account.id, balance: reading.balance, measured: true };
}
