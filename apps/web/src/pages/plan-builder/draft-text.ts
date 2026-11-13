import type { BuildDraft } from '../../api/client';

type Item = BuildDraft['items'][number];
type Cost = BuildDraft['summary']['cost'];

/** US dollars, whole when whole. */
export function money(amount: number): string {
  return `$${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
}

/**
 * The cost of the whole draft in words. A price that is not checked is never presented as a fact:
 * the total is called an estimate, and the lines say how many prices are not checked or unknown.
 */
export function costLines(cost: Cost): string[] {
  const lines: string[] = [];
  if (cost.total === 0 && !cost.estimated && cost.pricesToCheck === 0) {
    lines.push('Cost: $0. Everything in this draft is free.');
  } else if (cost.estimated) {
    lines.push(`Estimated cost: about ${money(cost.total)}.`);
  } else {
    lines.push(
      `Cost: ${money(cost.total)} by the catalog prices. Prices change, so check each one before you pay.`,
    );
  }
  if (cost.unverifiedPriceCount > 0) {
    lines.push(
      `${cost.unverifiedPriceCount} ${cost.unverifiedPriceCount === 1 ? 'price has' : 'prices have'} not been checked yet, so the total is an estimate.`,
    );
  }
  if (cost.pricesToCheck > 0) {
    lines.push(
      `+ ${cost.pricesToCheck} ${cost.pricesToCheck === 1 ? 'price' : 'prices'} to check (not in the total).`,
    );
  }
  if (cost.mayBeHigher) {
    lines.push(
      'The total may be higher: this draft does not fit before your finish date, so subscriptions are counted only up to it.',
    );
  }
  return lines;
}

/** The price of one item. A missing price says so; it is never shown as free or as a fact. */
export function itemCostText(item: Item): string {
  const { cost } = item;
  if (cost.kind === 'free') return 'Free';
  if (cost.amount === null) return 'Price varies – check';
  const base = cost.kind === 'certificate' ? `Exam fee ${money(cost.amount)}` : money(cost.amount);
  if (cost.kind === 'subscription') {
    return `Subscription, ${money(cost.amount)} per period${cost.months ? ` for ${cost.months} ${cost.months === 1 ? 'period' : 'periods'}` : ''}`;
  }
  return item.needsCheckPrice ? `${base} (price not checked)` : base;
}

/** The "Needs check" badges of an item, as words. */
export function itemBadges(item: Item): string[] {
  const out: string[] = [];
  if (item.needsCheckLink) out.push('Needs check: link');
  if (item.needsCheckPrice) out.push('Needs check: price');
  if (item.priceVaries) out.push('Price varies – check');
  return out;
}

export const EXCLUDED_REASON_TEXT: Record<string, string> = {
  excluded_by_user: 'You removed it',
  free_only: 'Not free',
  price_unknown: 'Price unknown',
  over_item_price: 'Over your single-item limit',
  over_budget: 'Over your budget',
  no_link: 'No link in the catalog',
  needs_prerequisite: 'Needs something that is not available',
  dropped_to_fit_time: 'Dropped to fit your time',
  dropped_to_fit_budget: 'Dropped to fit your budget',
  certificate_not_allowed: 'Certificate not allowed by your choices',
  exam_date_not_used: 'Exam date not used',
};
