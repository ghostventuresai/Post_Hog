from products.tasks.backend.code_workstreams.classify import (
    STALE_THRESHOLD_MS,
    ClassifyInput,
    ClassifyPr,
    classify,
    pick_primary_situation,
)

NOW = 1_700_000_000_000


def _pr(**overrides) -> ClassifyPr:
    base = {
        "state": "open",
        "ci_status": "passing",
        "review_decision": None,
        "unresolved_threads": 0,
        "is_current_user_author": True,
        "mergeable": True,
    }
    base.update(overrides)
    return ClassifyPr(**base)


def _input(**overrides) -> ClassifyInput:
    base = {
        "has_pr_url": False,
        "pr": None,
        "branch": None,
        "last_activity_at": NOW,
        "now": NOW,
    }
    base.update(overrides)
    return ClassifyInput(**base)


def test_merged_pr_is_done_and_exclusive():
    result = classify(_input(pr=_pr(state="merged", ci_status="failing")))
    assert result == {"done"}


def test_closed_pr_is_done():
    assert classify(_input(pr=_pr(state="closed"))) == {"done"}


def test_failing_ci_open_pr():
    assert classify(_input(pr=_pr(ci_status="failing"))) == {"ci_failing", "in_review"}


def test_changes_requested():
    result = classify(_input(pr=_pr(review_decision="changes_requested")))
    assert result == {"changes_requested", "in_review"}


def test_comments_waiting_only_for_author():
    author = classify(_input(pr=_pr(unresolved_threads=2, is_current_user_author=True)))
    assert "comments_waiting" in author

    non_author = classify(_input(pr=_pr(unresolved_threads=2, is_current_user_author=False)))
    assert "comments_waiting" not in non_author


def test_ready_to_merge_requires_all_signals():
    ready = classify(_input(pr=_pr(review_decision="approved", ci_status="passing", mergeable=True)))
    assert "ready_to_merge" in ready

    not_mergeable = classify(_input(pr=_pr(review_decision="approved", ci_status="passing", mergeable=False)))
    assert "ready_to_merge" not in not_mergeable


def test_pr_url_without_data_is_in_review():
    assert classify(_input(has_pr_url=True, pr=None)) == {"in_review"}


def test_branch_with_commits_is_working():
    assert classify(_input(branch="feat/x", commits_ahead=3)) == {"working"}
    # No git signal at all still counts as working.
    assert classify(_input(branch="feat/x", commits_ahead=None)) == {"working"}
    # Zero commits ahead doesn't surface as working.
    assert classify(_input(branch="feat/x", commits_ahead=0)) == set()


def test_stale_stacks_on_top():
    old = NOW - STALE_THRESHOLD_MS - 1
    result = classify(_input(pr=_pr(ci_status="failing"), last_activity_at=old))
    assert "stale" in result
    assert "ci_failing" in result


def test_stale_never_stacks_on_done():
    old = NOW - STALE_THRESHOLD_MS - 1
    result = classify(_input(pr=_pr(state="merged"), last_activity_at=old))
    assert result == {"done"}


def test_pick_primary_situation_priority():
    assert pick_primary_situation({"working", "ci_failing", "stale"}) == "ci_failing"
    assert pick_primary_situation({"stale", "working"}) == "working"
    assert pick_primary_situation(set()) is None
