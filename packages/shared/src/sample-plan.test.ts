import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// The fictional demo plan (spec section 7). Read via a relative JSON import (resolveJsonModule).
import demoPlanJson from '../../../data/sample-plans/demo-plan.json';
import { pickPodcast } from './podcasts';
import { parsePlanFile } from './schemas';
import { TAXONOMY_SKILL_IDS } from './taxonomy';
import { schedule } from './scheduling/engine';

const plan = parsePlanFile(demoPlanJson);
const today = '2026-11-01';
const result = schedule({ tasks: plan.tasks, pattern: plan.weekPattern, today });

describe('demo sample plan', () => {
  it('carries taxonomy skill ids, so the briefing can show an idea podcast', () => {
    expect(plan.skillIds).toEqual([
      'sql',
      'excel',
      'bi-visualization',
      'python',
      'interviewing',
      'jira',
    ]);
    for (const id of plan.skillIds ?? []) expect(TAXONOMY_SKILL_IDS.has(id)).toBe(true);
    expect(pickPodcast({ userSkillIds: plan.skillIds ?? [], date: today })).not.toBeNull();
  });

  it('parses and has the shape the spec describes', () => {
    expect(plan.formatVersion).toBe(1);
    expect(plan.tasks.length).toBeGreaterThanOrEqual(28);
    expect(plan.tasks.length).toBeLessThanOrEqual(32);
    expect(plan.tasks.some((t) => t.type === 'cv_update')).toBe(false);
    expect(plan.tasks.some((t) => t.isCertificate)).toBe(true);
    expect(plan.tasks.filter((t) => t.notBefore).length).toBeGreaterThanOrEqual(1);
    expect(plan.tasks.filter((t) => t.isAnchor)).toHaveLength(2);
    for (const t of plan.tasks) {
      expect(t.estHours).toBeGreaterThanOrEqual(0.25);
      expect(t.estHours).toBeLessThanOrEqual(40);
    }
  });

  it('never presents an unverified link as verified', () => {
    for (const t of plan.tasks) {
      // Catalog practice templates have no link at all; every other catalog item without one is flagged.
      if (t.externalRef?.startsWith('catalog:') && !t.url && t.provider !== 'Upversion practice') {
        expect(t.notes ?? '').toMatch(/needs check/i);
      }
    }
  });

  it('makes no link or price claim about a catalog item that the catalog does not back', () => {
    const catalog = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../../data/catalog/catalog.json', import.meta.url)),
        'utf8',
      ),
    ) as {
      items: {
        id: string;
        url: string | null;
        url_verified: boolean;
        price: number | null;
        price_verified: boolean;
      }[];
    };
    const byId = new Map(catalog.items.map((i) => [i.id, i]));
    for (const t of plan.tasks) {
      if (!t.externalRef?.startsWith('catalog:')) continue;
      const item = byId.get(t.externalRef.slice('catalog:'.length));
      expect(item, `${t.id} refers to a catalog item`).toBeDefined();
      if (!item) continue;
      const notes = t.notes ?? '';
      // Practice templates have no catalog link or price to claim.
      if (item.url === null) {
        expect(t.url, `${t.id} has no catalog link`).toBeUndefined();
        continue;
      }
      if (item.url_verified) {
        expect(t.url, `${t.id} url`).toBe(item.url);
        expect(notes, `${t.id} link note`).not.toMatch(/link not yet verified/i);
      } else {
        expect(t.url, `${t.id} unverified link`).toBeUndefined();
        expect(notes, `${t.id} link note`).toMatch(/needs check: link/i);
      }
      if (!item.price_verified) {
        const flag = item.price === null ? /price varies/i : /needs check: price/i;
        expect(notes, `${t.id} price note`).toMatch(flag);
      }
      // Any amount in the notes ("75 USD", "$75", "USD 1,200") must be the catalog price.
      const amounts = [
        ...notes.matchAll(
          /(\d[\d,]*(?:\.\d+)?)\s*USD|USD\s*(\d[\d,]*(?:\.\d+)?)|\$\s*(\d[\d,]*(?:\.\d+)?)/gi,
        ),
      ];
      for (const m of amounts) {
        const amount = Number((m[1] ?? m[2] ?? m[3] ?? '').replace(/,/g, ''));
        expect(amount, `${t.id} price amount`).toBe(item.price);
      }
    }
  });

  it('marks a lesson link verified only when it is an https link', () => {
    const lessons = plan.tasks.flatMap((t) => t.lessons.map((l) => ({ task: t, lesson: l })));
    expect(lessons.length).toBeGreaterThan(0);
    for (const { task, lesson } of lessons) {
      expect(task.type).toBe('course');
      if (!lesson.needsCheck) {
        expect(lesson.url, `${task.id} is verified`).toMatch(/^https:\/\//);
      }
      if (!lesson.url) expect(lesson.needsCheck, `${task.id} has no link`).toBe(true);
    }
  });

  it('keeps a course without verified lesson links free of lessons', () => {
    const excel = plan.tasks.find((t) => t.id === 'excel')!;
    expect(excel.lessons).toEqual([]);
    expect(excel.url).toBe('https://www.coursera.org/specializations/excel');
    expect(excel.notes ?? '').toMatch(/needs check/i);
  });

  it('gives every practice how-to steps and a prompt template', () => {
    for (const t of plan.tasks.filter((x) => x.type === 'practice')) {
      expect(t.howToSteps.length).toBeGreaterThanOrEqual(3);
      expect(t.promptTemplate).toBeTruthy();
    }
  });

  it('schedules everything with no warnings', () => {
    expect(result.warnings).toEqual([]);
  });

  it('puts both anchor exams on their dates and start times', () => {
    for (const anchor of plan.tasks.filter((t) => t.isAnchor)) {
      const blocks = result.blocks.filter((b) => b.taskId === anchor.id);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({
        date: anchor.anchorDate,
        start: anchor.anchorStartTime,
        kind: 'anchor',
      });
    }
  });

  it('keeps non-splittable tasks in one block and respects notBefore', () => {
    for (const t of plan.tasks.filter((x) => !x.splittable)) {
      expect(result.blocks.filter((b) => b.taskId === t.id)).toHaveLength(1);
    }
    for (const t of plan.tasks.filter((x) => x.notBefore)) {
      for (const b of result.blocks.filter((x) => x.taskId === t.id)) {
        expect(b.date >= t.notBefore!).toBe(true);
      }
    }
  });

  it('finishes within the plan period and fits the capacity', () => {
    expect(result.finishDate).not.toBeNull();
    expect(result.finishDate! <= plan.endDate!).toBe(true);
    const totalMinutes = plan.tasks.reduce((s, t) => s + Math.round(t.estHours * 60), 0);
    const capacity = result.days
      .filter((d) => d.date >= plan.startDate && d.date <= plan.endDate!)
      .reduce((s, d) => s + d.capacityMinutes, 0);
    expect(totalMinutes).toBeLessThanOrEqual(capacity);
    expect(result.blocks.reduce((s, b) => s + b.minutes, 0)).toBe(totalMinutes);
  });
});
