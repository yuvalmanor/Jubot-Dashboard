import { format, ratio } from "@/domain/money/money";
import { type BasisSplit, VALUE_BASES, VALUE_BASIS_LABELS } from "@/domain/snapshot/snapshot";

/**
 * What a total is made of. Per ADR 0003 a cost-held asset is never re-valued, so a
 * total that does not say how much of itself is cost is claiming to know more than
 * it does. Every total in מיפוי and in שווי נטו carries this line.
 */
export function BasisNote({ split, className = "" }: { split: BasisSplit; className?: string }) {
  const parts = VALUE_BASES.filter((basis) => split.byBasis[basis].minorUnits !== 0);

  if (parts.length === 0) {
    return <p className={`text-xs text-stone-500 ${className}`}>אין סכום שאפשר לפרק לפי בסיס שווי</p>;
  }

  if (parts.length === 1 && parts[0] === "market") {
    return <p className={`text-xs text-stone-500 ${className}`}>כל הסכום נמדד בשווי שוק</p>;
  }

  return (
    <p className={`text-xs text-stone-500 ${className}`}>
      {parts.map((basis, index) => (
        <span key={basis}>
          {index === 0 ? null : <span aria-hidden="true"> · </span>}
          {VALUE_BASIS_LABELS[basis]}{" "}
          <bdi className="tabular">{format(split.byBasis[basis])}</bdi>
          <SharePart share={ratio(split.byBasis[basis], split.total)} />
        </span>
      ))}
    </p>
  );
}

const PERCENT = new Intl.NumberFormat("he-IL", { style: "percent", maximumFractionDigits: 0 });

function SharePart({ share }: { share: number | null }) {
  // A share of nothing is not 0% — a total of zero has no percentages in it.
  if (share === null) return null;
  return (
    <>
      {" ("}
      <bdi className="tabular">{PERCENT.format(share)}</bdi>
      {")"}
    </>
  );
}
