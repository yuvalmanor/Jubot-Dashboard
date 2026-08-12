import { type RsuRecords } from "@/db/rsu";
import { type SharePrice } from "@/domain/rsu/rsu-position";
import { type CalendarDate, compareDates, formatDate } from "@/domain/time/calendar-date";

/**
 * The most recent price anybody recorded. Not a market price — nothing in this
 * system reads one — so it always travels with a sentence saying where it came
 * from, and every screen that offers it as a default says so beside the figure.
 *
 * It lives apart from the screens because both מחשבון RSU and מיפוי want it: the
 * first to price a sale, the second as the default for the price a snapshot is
 * taken at.
 */
export interface KnownPrice {
  readonly price: SharePrice;
  readonly from: string;
}

function latestBy<T>(items: readonly T[], on: (item: T) => CalendarDate): T | null {
  return items.reduce<T | null>(
    (latest, item) => (latest === null || compareDates(on(item), on(latest)) > 0 ? item : latest),
    null,
  );
}

export function latestKnownPrice(records: RsuRecords): KnownPrice | null {
  const latestSale = latestBy(records.sales, (sale) => sale.soldOn);
  if (latestSale !== null) {
    return { price: latestSale.price, from: `המכירה האחרונה שנרשמה, ${formatDate(latestSale.soldOn)}` };
  }

  const latestVest = latestBy(records.vests, (vest) => vest.vestedOn);
  if (latestVest !== null) {
    return { price: latestVest.priceAtVest, from: `ההבשלה האחרונה שנרשמה, ${formatDate(latestVest.vestedOn)}` };
  }

  return null;
}
