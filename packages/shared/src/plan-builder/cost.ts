import { compareDates, diffDays } from '../dates';
import type { Block } from '../schemas';
import { cents, isFreeItem } from './budget';
import type { Member } from './resolve';
import type { CostLine, CostReport, ItemCost } from './schemas';

/** Days in the month a subscription is billed for when counting months from a span of days. */
export const DAYS_PER_MONTH = 30;
const DAYS_PER_YEAR = 365;

/** How many calendar days a set of catalog items is scheduled over (last - first + 1), or null when none is scheduled. */
export type SpanOf = (key: string, catalogIds: readonly string[]) => number | null;

/** Span of days from the scheduled blocks (step 10). */
export function spanFromBlocks(
  blocks: readonly Block[],
  taskItem: ReadonlyMap<string, string>,
): SpanOf {
  const range = new Map<string, { first: string; last: string }>();
  for (const b of blocks) {
    const id = taskItem.get(b.taskId);
    if (!id) continue;
    const r = range.get(id);
    if (!r) range.set(id, { first: b.date, last: b.date });
    else {
      if (compareDates(b.date, r.first) < 0) r.first = b.date;
      if (compareDates(b.date, r.last) > 0) r.last = b.date;
    }
  }
  return (_key, ids) => {
    let first: string | null = null;
    let last: string | null = null;
    for (const id of ids) {
      const r = range.get(id);
      if (!r) continue;
      if (first === null || compareDates(r.first, first) < 0) first = r.first;
      if (last === null || compareDates(r.last, last) > 0) last = r.last;
    }
    return first === null || last === null ? null : diffDays(first, last) + 1;
  };
}

/** Span of days taken from an earlier cost report, for a cost estimate before the plan is re-scheduled. */
export function spanFromReport(previous: CostReport): SpanOf {
  return (key) => {
    if (key.startsWith('group:')) {
      const months = previous.subscriptionMonths[key.slice(6)];
      return months ? months * DAYS_PER_MONTH : null;
    }
    const line = previous.lines.find((l) => `item:${l.catalogId}` === key);
    return line?.periods ? line.periods * DAYS_PER_MONTH : null;
  };
}

/**
 * Step 10: the cost of the plan, recomputed from the catalog. One-time prices are summed; a
 * subscription group is paid once per month it is used (months = ceil(days / 30), at least 1);
 * a subscription outside a group counts its own period; a `free_audit` item costs nothing unless
 * its paid certificate is bought. A price that is null is not added (it counts in `pricesToCheck`).
 */
export function computeCost(members: readonly Member[], span: SpanOf): CostReport {
  const lines: CostLine[] = [];
  const subscriptionMonths: Record<string, number> = {};
  let pricesToCheck = 0;
  let estimated = false;

  const groups = new Map<string, Member[]>();
  for (const m of members) {
    const { item } = m;
    if (item.type !== 'practice' && !item.price_verified) estimated = true;
    if (item.cost_type === 'subscription') {
      if (item.subscription_group) {
        const list = groups.get(item.subscription_group) ?? [];
        list.push(m);
        groups.set(item.subscription_group, list);
        continue;
      }
      const price = item.price;
      if (price === null) {
        pricesToCheck += 1;
        lines.push({
          catalogId: item.id,
          kind: 'subscription',
          amount: null,
          priceVerified: item.price_verified,
        });
        continue;
      }
      const days = span(`item:${item.id}`, [item.id]) ?? 1;
      const unit = item.subscription_period === 'year' ? DAYS_PER_YEAR : DAYS_PER_MONTH;
      const periods = Math.max(1, Math.ceil(days / unit));
      lines.push({
        catalogId: item.id,
        kind: 'subscription',
        amount: cents(price * periods),
        priceVerified: item.price_verified,
        periods,
      });
      continue;
    }
    if (item.cost_type === 'one_time') {
      if (item.price === null) pricesToCheck += 1;
      lines.push({
        catalogId: item.id,
        kind: 'one_time',
        amount: item.price === null ? null : cents(item.price),
        priceVerified: item.price_verified,
      });
    }
    if (m.paidCertificate && isFreeItem(item)) {
      estimated = true;
      if (item.certificate_price === null) pricesToCheck += 1;
      lines.push({
        catalogId: item.id,
        kind: 'certificate',
        amount: item.certificate_price === null ? null : cents(item.certificate_price),
        priceVerified: false,
      });
    }
  }
  for (const [group, list] of [...groups].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const sorted = [...list].sort((a, b) => (a.id < b.id ? -1 : 1));
    const days =
      span(
        `group:${group}`,
        sorted.map((m) => m.id),
      ) ?? 1;
    const months = Math.max(1, Math.ceil(days / DAYS_PER_MONTH));
    subscriptionMonths[group] = months;
    const priced = sorted.find((m) => m.item.price !== null);
    const first = sorted[0] as Member;
    if (!priced) {
      pricesToCheck += 1;
      lines.push({
        catalogId: first.id,
        kind: 'subscription',
        amount: null,
        priceVerified: false,
        subscriptionGroup: group,
      });
      continue;
    }
    lines.push({
      catalogId: priced.id,
      kind: 'subscription',
      amount: cents((priced.item.price as number) * months),
      priceVerified: sorted.every((m) => m.item.price_verified),
      periods: months,
      subscriptionGroup: group,
    });
  }
  lines.sort((a, b) => (a.catalogId < b.catalogId ? -1 : a.catalogId > b.catalogId ? 1 : 0));
  const total = cents(lines.reduce((sum, l) => sum + (l.amount ?? 0), 0));
  return { currency: 'USD', total, estimated, pricesToCheck, lines, subscriptionMonths };
}

/** The cost shown on one item of the draft. */
export function itemCostOf(member: Member, report: CostReport): ItemCost {
  const { item } = member;
  if (item.cost_type === 'subscription') {
    const group = item.subscription_group;
    const months = group
      ? report.subscriptionMonths[group]
      : report.lines.find((l) => l.catalogId === item.id)?.periods;
    return {
      amount: item.price,
      kind: 'subscription',
      ...(months ? { months } : {}),
    };
  }
  if (member.paidCertificate && isFreeItem(item)) {
    return { amount: item.certificate_price, kind: 'certificate' };
  }
  if (isFreeItem(item) || item.type === 'practice') return { amount: 0, kind: 'free' };
  return { amount: item.price, kind: 'one_time' };
}
