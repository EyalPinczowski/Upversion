import type { CatalogItem } from './catalog';
import type { BuildRequest } from './schemas';

type Budget = BuildRequest['budget'];

/** Why an item fails the budget filter (a subset of the excluded reasons). */
export type BudgetReason = 'free_only' | 'price_unknown' | 'over_item_price' | 'over_budget';

export function isFreeItem(item: CatalogItem): boolean {
  return item.cost_type === 'free' || item.cost_type === 'free_audit';
}

/**
 * The price one purchase of the item costs: 0 for a free item (a `free_audit` item costs nothing
 * unless its certificate is bought), the catalog price otherwise, null when the catalog has none.
 * A subscription's price is the price of one period.
 */
export function effectivePrice(item: CatalogItem): number | null {
  if (isFreeItem(item)) return 0;
  return item.price;
}

/**
 * Item budget filter (ADR 017 steps 2 and 4, owner Q12). `free`: no paid item. `limit`: the
 * price must be known and not above the limit (the total is checked later). `maxItemPrice` caps
 * a single item in every mode. `flexible` keeps an item whose price is unknown.
 */
export function itemBudgetReason(item: CatalogItem, budget: Budget): BudgetReason | null {
  if (budget.mode === 'free') return isFreeItem(item) ? null : 'free_only';
  const price = effectivePrice(item);
  if (price === null) return budget.mode === 'flexible' ? null : 'price_unknown';
  if (budget.maxItemPrice !== undefined && price > budget.maxItemPrice) return 'over_item_price';
  if (budget.mode === 'limit' && budget.amount !== undefined && price > budget.amount) {
    return 'over_budget';
  }
  return null;
}

/** The same filter for buying the certificate of a `free_audit` item (its `certificate_price`). */
export function certificateBudgetReason(item: CatalogItem, budget: Budget): BudgetReason | null {
  if (budget.mode === 'free') return 'free_only';
  const price = item.certificate_price;
  if (price === null) return budget.mode === 'flexible' ? null : 'price_unknown';
  if (budget.maxItemPrice !== undefined && price > budget.maxItemPrice) return 'over_item_price';
  if (budget.mode === 'limit' && budget.amount !== undefined && price > budget.amount) {
    return 'over_budget';
  }
  return null;
}

/** Round to cents, so sums of prices never show floating point noise. */
export function cents(value: number): number {
  return Math.round(value * 100) / 100;
}
