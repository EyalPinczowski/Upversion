-- Per-task skill ids (ADR 018, B2). Additive and backward compatible: one nullable column, no
-- default, no data change, nothing dropped or renamed. RLS and grants are unchanged (the table's
-- policies filter on user_id only, so the new column is covered like every other column).
--
-- tasks.skill_ids: taxonomy skill ids the task builds. NULL means unknown (rows written before
-- this migration, or by a client that does not send them): readers fall back to the catalog item
-- named by external_ref. An empty array means "builds no skill" (for example a booking task) and
-- must NOT fall back. The API validates the ids against the taxonomy before writing.
set local role {{owner}};

alter table {{schema}}.tasks
  add column if not exists skill_ids text[]
    check (skill_ids is null or cardinality(skill_ids) <= 10);

comment on column {{schema}}.tasks.skill_ids is
  'Taxonomy skill ids this task builds. NULL = unknown (fall back to the catalog item); empty array = builds no skill.';
