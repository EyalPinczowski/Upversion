"""Tests for lint.py. Run from data/catalog/build:  python3 -m unittest test_lint -v

Each lint rule has a test that fails when the rule is violated, using small fixtures, plus a
test that the real catalog passes.
"""
import copy
import unittest

import lint


def item(iid, prereqs=(), kinds=None, **kw):
    base = {
        "id": iid, "url": f"https://example.com/{iid}", "url_verified": False,
        "cost_type": "free", "price": 0, "subscription_period": None,
        "prerequisites": list(prereqs), "skills": ["sql"],
        "prerequisite_kinds": kinds if kinds is not None else {p: "required" for p in prereqs},
        "last_verified_at": None, "subscription_group": None, "skill_depth": {},
    }
    base.update(kw)
    return base


def role(core):
    return {"id": "r", "suggested_path": {"core": core}}


class CheckItems(unittest.TestCase):
    def test_clean_fixture_passes(self):
        self.assertEqual(lint.check_items([item("a"), item("b", ["a"])]), [])

    def test_missing_url_allowed_only_when_unverified_and_flagged(self):
        ok = item("a", url=None, type="course", notes="No url yet. Needs check: url and price.")
        self.assertEqual(lint.check_items([ok]), [])
        no_flag = item("a", url=None, type="course", notes="")
        self.assertTrue(any("missing url" in e for e in lint.check_items([no_flag])))
        price_only = item("a", url=None, type="course", notes="Needs check: price.")
        self.assertTrue(any("missing url" in e for e in lint.check_items([price_only])))
        verified = item("a", url=None, type="course", url_verified=True, notes="needs check: url")
        self.assertTrue(any("missing url" in e for e in lint.check_items([verified])))
        practice = item("a", url=None, type="practice", notes="")
        self.assertEqual(lint.check_items([practice]), [])

    def test_missing_url_with_a_verification_date_fails(self):
        bad = item("a", url=None, type="course", notes="Needs check: url.", last_verified_at="2026-11-01")
        self.assertTrue(any("must be null when the item has no url" in e for e in lint.check_items([bad])))

    def test_missing_prerequisite_fails(self):
        errs = lint.check_items([item("b", ["ghost"])])
        self.assertTrue(any("ghost does not exist" in e for e in errs), errs)

    def test_cycle_fails_and_reports_the_exact_cycle(self):
        items = [item("a", ["b"]), item("b", ["c"]), item("c", ["a"]), item("d")]
        errs = lint.check_items(items)
        self.assertIn("prerequisite cycle: a -> b -> c -> a", errs)

    def test_cycle_through_a_recommended_edge_still_fails(self):
        items = [item("a", ["b"], {"b": "recommended"}), item("b", ["a"])]
        self.assertTrue(any("prerequisite cycle" in e for e in lint.check_items(items)))

    def test_self_prerequisite_fails(self):
        self.assertTrue(lint.check_items([item("a", ["a"])]))

    def test_verified_url_must_be_https(self):
        self.assertTrue(lint.check_items([item("a", url_verified=True, url="http://example.com")]))
        self.assertTrue(lint.check_items([item("a", url_verified=True, url=None)]))
        self.assertEqual(lint.check_items([item("a", url_verified=True)]), [])
        # an unverified item may have a non-https url
        self.assertEqual(lint.check_items([item("a", url="http://example.com")]), [])

    def test_prerequisite_kinds_must_match_prerequisites_and_values(self):
        self.assertTrue(lint.check_items([item("a"), item("b", ["a"], {})]))
        self.assertTrue(lint.check_items([item("a"), item("b", ["a"], {"a": "sometimes"})]))
        self.assertEqual(lint.check_items([item("a"), item("b", ["a"], {"a": "recommended"})]), [])

    def test_last_verified_at_format(self):
        self.assertEqual(lint.check_items([item("a", last_verified_at="2026-11-01")]), [])
        self.assertTrue(lint.check_items([item("a", last_verified_at="1 Nov 2026")]))

    def test_subscription_group_rules(self):
        sub = dict(cost_type="subscription", price=59, subscription_period="month")
        ok = [item("a", subscription_group="plus", **sub), item("b", subscription_group="plus", **sub)]
        self.assertEqual(lint.check_items(ok), [])
        self.assertTrue(lint.check_items([item("a", subscription_group="plus")]))  # not a subscription
        bad = [item("a", subscription_group="plus", **sub),
               item("b", subscription_group="plus", **{**sub, "price": 10})]
        self.assertTrue(lint.check_items(bad))

    def test_skill_depth_rules(self):
        self.assertEqual(lint.check_items([item("a", skill_depth={"sql": "intermediate"})]), [])
        self.assertTrue(lint.check_items([item("a", skill_depth={"python": "beginner"})]))  # not an item skill
        self.assertTrue(lint.check_items([item("a", skill_depth={"sql": "expert"})]))


class RolePaths(unittest.TestCase):
    items = [item("a"), item("b", ["a"]), item("c", ["b"]), item("opt", ["a"], {"a": "recommended"})]

    def test_closed_ordered_core_passes(self):
        self.assertEqual(lint.check_role_paths(self.items, [role(["a", "b", "c"])]), [])

    def test_missing_required_prerequisite_fails(self):
        errs = lint.check_role_paths(self.items, [role(["b"])])
        self.assertTrue(any("needs prerequisite a" in e for e in errs), errs)

    def test_missing_transitive_prerequisite_fails(self):
        self.assertTrue(lint.check_role_paths(self.items, [role(["a", "c"])]))

    def test_prerequisite_after_dependent_fails(self):
        self.assertTrue(lint.check_role_paths(self.items, [role(["b", "a"])]))

    def test_recommended_prerequisite_may_be_absent(self):
        self.assertEqual(lint.check_role_paths(self.items, [role(["opt"])]), [])


class Closure(unittest.TestCase):
    def test_closure_is_prerequisites_first_and_deduplicated(self):
        items = {i["id"]: i for i in [item("a"), item("b", ["a"]), item("c", ["a"]), item("d", ["b", "c"])]}
        self.assertEqual(lint.ordered_required_closure("d", items), ["a", "b", "c", "d"])

    def test_recommended_prerequisites_are_not_pulled_in(self):
        items = {i["id"]: i for i in [item("a"), item("b", ["a"], {"a": "recommended"})]}
        self.assertEqual(lint.ordered_required_closure("b", items), ["b"])


def _roles():
    import json
    import os
    with open(os.path.join(os.path.dirname(__file__), "..", "roles.json")) as f:
        return json.load(f)["roles"]


class RolePathUrls(unittest.TestCase):
    def test_item_without_url_in_any_path_list_fails(self):
        nourl = item("n", url=None, type="course", notes="Needs check: url.")
        ok = item("o", type="course")
        for lst in ("core", "optional", "free_only"):
            path = {"core": [], "optional": [], "practice": [], "free_only": []}
            path[lst] = ["n"]
            errs = lint.check_role_paths([nourl, ok], [{"id": "r", "suggested_path": path}])
            self.assertTrue(any("has no url" in e for e in errs), (lst, errs))
        path = {"core": ["o"], "optional": [], "practice": [], "free_only": []}
        self.assertEqual(lint.check_role_paths([nourl, ok], [{"id": "r", "suggested_path": path}]), [])


class SetupQuestions(unittest.TestCase):
    """ADR 015 setup-question rules (lint.check_setup_questions)."""

    @staticmethod
    def qs():
        from questions import Q
        return copy.deepcopy(Q)

    @staticmethod
    def by_id(qs, qid):
        return next(q for q in qs if q["id"] == qid)

    def test_real_questions_pass(self):
        self.assertEqual(lint.check_setup_questions(self.qs()), [])

    def test_the_eight_ids_in_order(self):
        flagged = sorted((q for q in self.qs() if "setup" in q), key=lambda q: q["setup"]["order"])
        self.assertEqual([q["id"] for q in flagged], [
            "current_status", "education", "tools_known", "days_per_week",
            "hours_per_day", "time_of_day", "target_role", "target_skills"])
        self.assertEqual([q["setup"]["order"] for q in flagged], list(range(1, 9)))

    def test_show_if_without_ignore_show_if_fails(self):
        qs = self.qs()
        del self.by_id(qs, "target_role")["setup"]["ignore_show_if"]
        self.assertTrue(any("show_if without" in e for e in lint.check_setup_questions(qs)))
        qs = self.qs()
        self.by_id(qs, "education")["show_if"] = {"goal_type": ["new_role"]}
        self.assertTrue(any("education" in e and "show_if" in e for e in lint.check_setup_questions(qs)))

    def test_allow_other_without_choices_only_fails(self):
        qs = self.qs()
        del self.by_id(qs, "target_skills")["setup"]["choices_only"]
        self.assertTrue(any("allow_other without" in e for e in lint.check_setup_questions(qs)))

    def test_privacy_fails(self):
        qs = self.qs()
        self.by_id(qs, "education")["privacy"] = "strip_pii"
        self.assertTrue(any("privacy" in e for e in lint.check_setup_questions(qs)))

    def test_ninth_flagged_question_fails(self):
        qs = self.qs()
        self.by_id(qs, "goal_type")["setup"] = {"order": 9}
        errs = lint.check_setup_questions(qs)
        self.assertTrue(any("exactly 8" in e for e in errs), errs)

    def test_fewer_than_eight_fails(self):
        qs = self.qs()
        del self.by_id(qs, "time_of_day")["setup"]
        self.assertTrue(any("exactly 8" in e for e in lint.check_setup_questions(qs)))

    def test_duplicate_or_out_of_range_order_fails(self):
        qs = self.qs()
        self.by_id(qs, "education")["setup"]["order"] = 1
        self.assertTrue(any("orders must be" in e for e in lint.check_setup_questions(qs)))
        qs = self.qs()
        self.by_id(qs, "target_skills")["setup"]["order"] = 9
        self.assertTrue(any("orders must be" in e for e in lint.check_setup_questions(qs)))

    def test_type_outside_allowlist_fails(self):
        for bad in ("text", "text_or_url", "date_list", "budget", "catalog_search", "money", "skill_matrix"):
            qs = self.qs()
            self.by_id(qs, "education")["type"] = bad
            errs = lint.check_setup_questions(qs)
            self.assertTrue(any("not allowed in setup" in e for e in errs), (bad, errs))

    def test_every_allowed_type_passes_the_type_rule(self):
        for ok in lint.SETUP_TYPES:
            qs = self.qs()
            self.by_id(qs, "education")["type"] = ok
            self.assertFalse(any("not allowed" in e for e in lint.check_setup_questions(qs)), ok)

    def test_plan_builder_definitions_of_target_questions_unchanged(self):
        qs = self.qs()
        for qid in ("target_role", "target_skills"):
            q = self.by_id(qs, qid)
            self.assertTrue(q["allow_other"] and q["required"] and q["show_if"], qid)


class RealCatalog(unittest.TestCase):
    def test_generated_catalog_passes_the_lint(self):
        from taxonomy import ROLES
        from catalog import ITEMS
        import json
        import os
        roles = _roles()
        self.assertEqual(len(roles), len(ROLES))
        self.assertEqual(lint.lint(ITEMS, roles), [])

    def test_real_catalog_with_a_prerequisite_dropped_from_core_fails(self):
        import json
        import os
        from catalog import ITEMS
        roles = _roles()
        mutated = copy.deepcopy(roles)
        core = next(r for r in mutated if r["id"] == "qa-tester")["suggested_path"]["core"]
        core.remove("scrum-guide")
        self.assertTrue(lint.check_role_paths(ITEMS, mutated))


if __name__ == "__main__":
    unittest.main()
