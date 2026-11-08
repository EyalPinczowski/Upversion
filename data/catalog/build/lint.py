"""Catalog lint and prerequisite helpers. Used by build.py; every function is pure so the
tests in test_lint.py can feed it small fixtures.

Each check returns a list of error strings; an empty list means the data is fine.
"""
import re

PREREQ_KINDS = ("required", "recommended")
DEPTH_LEVELS = ("beginner", "intermediate", "advanced")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def required_prereqs(item):
    """Ids of the item's required prerequisites, in the order they are listed."""
    kinds = item.get("prerequisite_kinds") or {}
    return [p for p in item["prerequisites"] if kinds.get(p, "required") == "required"]


def ordered_required_closure(item_id, by_id):
    """The item plus its transitive required prerequisites, prerequisites first (depth-first
    post-order, each id once). Unknown ids and cycles are skipped here; check_prerequisites
    reports them."""
    out, seen = [], set()

    def visit(i):
        if i in seen or i not in by_id:
            return
        seen.add(i)
        for p in required_prereqs(by_id[i]):
            visit(p)
        out.append(i)

    visit(item_id)
    return out


def find_cycle(items):
    """Return one prerequisite cycle as a list like [a, b, c, a], or None. All prerequisite
    edges count, required and recommended."""
    by_id = {i["id"]: i for i in items}
    state = {}  # id -> 1 visiting, 2 done
    stack = []

    def visit(i):
        state[i] = 1
        stack.append(i)
        for p in by_id[i]["prerequisites"]:
            if p not in by_id:
                continue
            if state.get(p) == 1:
                return stack[stack.index(p):] + [p]
            if p not in state:
                found = visit(p)
                if found:
                    return found
        stack.pop()
        state[i] = 2
        return None

    for i in by_id:
        if i not in state:
            found = visit(i)
            if found:
                return found
    return None


def check_items(items, skill_ids=None):
    errs = []
    ids = {i["id"] for i in items}
    for it in items:
        iid = it["id"]
        for p in it["prerequisites"]:
            if p not in ids:
                errs.append(f"{iid}: prerequisite {p} does not exist")
            if p == iid:
                errs.append(f"{iid}: lists itself as a prerequisite")
        kinds = it.get("prerequisite_kinds")
        if not isinstance(kinds, dict) or set(kinds) != set(it["prerequisites"]):
            errs.append(f"{iid}: prerequisite_kinds must have exactly one entry per prerequisite")
        else:
            for p, k in kinds.items():
                if k not in PREREQ_KINDS:
                    errs.append(f"{iid}: prerequisite_kinds[{p}] is {k!r}, expected one of {PREREQ_KINDS}")
        if it["url_verified"] and not (it["url"] or "").startswith("https://"):
            errs.append(f"{iid}: url_verified is true but the url is not an https url")
        if it.get("type") != "practice" and not it["url"]:
            # A learning item without a url is allowed only while it is unverified and says so.
            if it["url_verified"] or "needs check: url" not in (it.get("notes") or "").lower():
                errs.append(f"{iid}: missing url (allowed only when url_verified is false and notes contain 'needs check: url')")
            if it.get("last_verified_at") is not None:
                errs.append(f"{iid}: last_verified_at must be null when the item has no url")
        lv = it.get("last_verified_at")
        if lv is not None and not (isinstance(lv, str) and DATE_RE.match(lv)):
            errs.append(f"{iid}: last_verified_at must be YYYY-MM-DD or null, got {lv!r}")
        grp = it.get("subscription_group")
        if grp is not None:
            if it["cost_type"] != "subscription":
                errs.append(f"{iid}: subscription_group is set but cost_type is {it['cost_type']}")
            elif not isinstance(grp, str) or not grp:
                errs.append(f"{iid}: subscription_group must be a non-empty string or null")
        depth = it.get("skill_depth")
        if not isinstance(depth, dict):
            errs.append(f"{iid}: skill_depth must be an object (empty when unset)")
        else:
            for s, d in depth.items():
                if s not in it["skills"]:
                    errs.append(f"{iid}: skill_depth names {s}, which is not one of the item's skills")
                if d not in DEPTH_LEVELS:
                    errs.append(f"{iid}: skill_depth[{s}] is {d!r}, expected one of {DEPTH_LEVELS}")
    cycle = find_cycle(items) if not any("does not exist" in e for e in errs) else None
    if cycle:
        errs.append("prerequisite cycle: " + " -> ".join(cycle))
    # A subscription group is one subscription: members must agree on what it costs.
    groups = {}
    for it in items:
        if it.get("subscription_group"):
            groups.setdefault(it["subscription_group"], []).append(it)
    for g, members in groups.items():
        periods = {m["subscription_period"] for m in members}
        if len(periods) > 1:
            errs.append(f"subscription_group {g}: items disagree on subscription_period {sorted(map(str, periods))}")
        prices = {m["price"] for m in members if m["price"] is not None}
        if len(prices) > 1:
            errs.append(f"subscription_group {g}: items disagree on price {sorted(prices)}")
    return errs


def check_role_paths(items, roles):
    """Every required prerequisite of a `core` item must be in `core`, before the item. No path
    list may hold a learning item without a url."""
    by_id = {i["id"]: i for i in items}
    errs = []
    for r in roles:
        # An item without a url cannot be opened, so it must not be recommended in any list.
        for lst, ids in r["suggested_path"].items():
            for x in ids:
                it = by_id.get(x)
                if it is not None and it.get("type") != "practice" and not it.get("url"):
                    errs.append(f"role {r['id']}: {lst} item {x} has no url")
        core = r["suggested_path"]["core"]
        pos = {x: n for n, x in enumerate(core)}
        for x in core:
            if x not in by_id:
                errs.append(f"role {r['id']}: core item {x} does not exist")
                continue
            for p in required_prereqs(by_id[x]):
                if p not in pos:
                    errs.append(f"role {r['id']}: core item {x} needs prerequisite {p}, which is not in core")
                elif pos[p] > pos[x]:
                    errs.append(f"role {r['id']}: core item {x} comes before its prerequisite {p}")
    return errs


SETUP_TYPES = ("single", "multi", "weekdays", "number", "yes_no", "multi_role", "multi_skill")
SETUP_COUNT = 8
SETUP_FLAGS = ("order", "ignore_show_if", "choices_only", "optional")


def check_setup_questions(questions):
    """ADR 015 rules for questions flagged `setup`: exactly 8, orders 1..8 unique, type on the
    allowlist (so a free-text type cannot slip in), no show_if unless setup.ignore_show_if, no
    allow_other unless setup.choices_only, no privacy."""
    errs = []
    flagged = [q for q in questions if "setup" in q]
    if len(flagged) != SETUP_COUNT:
        errs.append(f"setup: expected exactly {SETUP_COUNT} setup questions, found {len(flagged)}")
    orders = []
    for q in flagged:
        qid, flag = q["id"], q["setup"]
        if not isinstance(flag, dict):
            errs.append(f"setup question {qid}: setup must be an object")
            flag = {}
        order = flag.get("order")
        if not isinstance(order, int) or isinstance(order, bool):
            errs.append(f"setup question {qid}: setup.order must be an integer")
        else:
            orders.append(order)
        for k, v in flag.items():
            if k not in SETUP_FLAGS:
                errs.append(f"setup question {qid}: unknown setup field {k}")
            elif k != "order" and v is not True:
                errs.append(f"setup question {qid}: setup.{k} must be true when present")
        if q.get("type") not in SETUP_TYPES:
            errs.append(f"setup question {qid}: type {q.get('type')!r} is not allowed in setup (allowed: {', '.join(SETUP_TYPES)})")
        if q.get("show_if") and not flag.get("ignore_show_if"):
            errs.append(f"setup question {qid}: has show_if without setup.ignore_show_if")
        if q.get("allow_other") and not flag.get("choices_only"):
            errs.append(f"setup question {qid}: has allow_other without setup.choices_only")
        if "privacy" in q:
            errs.append(f"setup question {qid}: has privacy (setup collects no free text)")
    if sorted(orders) != list(range(1, SETUP_COUNT + 1)):
        errs.append(f"setup: orders must be exactly 1..{SETUP_COUNT}, each once; got {sorted(orders)}")
    return errs


def lint(items, roles, skill_ids=None):
    return check_items(items, skill_ids) + check_role_paths(items, roles)
