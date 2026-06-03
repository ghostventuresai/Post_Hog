from products.tasks.backend.code_workstreams.classify import STALE_THRESHOLD_MS
from products.tasks.backend.code_workstreams.grouping import (
    RUNNING_STALE_THRESHOLD_MS,
    PrInput,
    TaskInput,
    build_workstreams,
    workstream_key,
)

NOW = 1_700_000_000_000


def _task(**overrides) -> TaskInput:
    base = {
        "id": "t1",
        "title": "Task",
        "status": "completed",
        "last_activity_at": NOW,
        "repo_name": "posthog",
        "repo_full_path": "posthog/posthog",
        "branch": "feat/x",
        "cloud_pr_url": None,
        "folder_path": None,
    }
    base.update(overrides)
    return TaskInput(**base)


def _pr(**overrides) -> PrInput:
    base = {
        "url": "https://github.com/posthog/posthog/pull/1",
        "number": 1,
        "title": "PR",
        "state": "open",
        "ci_status": "passing",
        "review_decision": None,
        "unresolved_threads": 0,
        "mergeable": True,
        "is_current_user_requested_reviewer": False,
        "is_current_user_author": True,
        "author": "me",
        "last_updated_at": NOW,
    }
    base.update(overrides)
    return PrInput(**base)


def test_workstream_key_precedence():
    task = _task(branch="b", repo_name="r", folder_path="/p")
    assert workstream_key(task, "https://x/pull/9") == "pr:https://x/pull/9"
    assert workstream_key(task, None) == "branch:r#b"
    assert workstream_key(_task(branch=None, repo_name=None, folder_path="/p"), None) == "path:/p"
    assert workstream_key(_task(branch=None, repo_name=None, folder_path=None), None) is None


def test_running_task_no_pr_is_excluded_from_workstreams():
    # A live agent with no PR is surfaced by the API's live strip, not grouped.
    result = build_workstreams([_task(status="in_progress", branch=None, folder_path=None)], {}, NOW)
    assert not result.needs_attention
    assert not result.in_progress


def test_running_task_with_pr_is_grouped():
    task = _task(status="in_progress")
    result = build_workstreams([task], {task.id: _pr(ci_status="failing")}, NOW)
    assert len(result.needs_attention) == 1


def test_idle_running_task_falls_through_to_grouping():
    old = NOW - RUNNING_STALE_THRESHOLD_MS - 1
    task = _task(status="in_progress", last_activity_at=old)
    result = build_workstreams([task], {}, NOW)
    assert len(result.in_progress) == 1


def test_failing_ci_lands_in_needs_attention():
    task = _task()
    result = build_workstreams([task], {task.id: _pr(ci_status="failing")}, NOW)
    assert len(result.needs_attention) == 1
    ws = result.needs_attention[0]
    assert ws.pr_url == _pr().url
    assert "ci_failing" in ws.situations


def test_healthy_open_pr_lands_in_in_progress():
    task = _task()
    result = build_workstreams([task], {task.id: _pr()}, NOW)
    assert len(result.in_progress) == 1
    assert result.in_progress[0].situations == ["in_review"]


def test_tasks_group_by_shared_pr_url():
    url = "https://github.com/posthog/posthog/pull/42"
    t1 = _task(id="a", branch="x", last_activity_at=NOW)
    t2 = _task(id="b", branch="y", last_activity_at=NOW - 1000)
    pr_by_task = {"a": _pr(url=url), "b": _pr(url=url)}
    result = build_workstreams([t1, t2], pr_by_task, NOW)
    assert len(result.needs_attention) + len(result.in_progress) == 1
    ws = (result.needs_attention + result.in_progress)[0]
    assert {t.id for t in ws.tasks} == {"a", "b"}


def test_stale_branch_no_pr_is_attention():
    old = NOW - STALE_THRESHOLD_MS - 1
    task = _task(status="completed", last_activity_at=old, cloud_pr_url=None)
    result = build_workstreams([task], {}, NOW)
    assert len(result.needs_attention) == 1
    assert "stale" in result.needs_attention[0].situations


def test_task_without_grouping_key_is_skipped():
    task = _task(status="completed", branch=None, repo_name=None, folder_path=None, cloud_pr_url=None)
    result = build_workstreams([task], {}, NOW)
    assert not result.needs_attention
    assert not result.in_progress
