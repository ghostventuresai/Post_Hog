from collections.abc import Iterable
from dataclasses import dataclass
from typing import Literal, Optional

from .situations import SITUATION_PRIORITY, SituationId

# A workstream with no activity for this long is considered stale (epoch ms).
STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000

PrState = Literal["open", "draft", "merged", "closed"]
CiStatus = Literal["passing", "failing", "pending", "none"]
ReviewDecision = Literal["approved", "changes_requested", "review_required"]


@dataclass
class ClassifyPr:
    state: PrState
    ci_status: CiStatus
    review_decision: Optional[ReviewDecision]
    unresolved_threads: int
    is_current_user_author: bool
    mergeable: Optional[bool] = None


@dataclass
class ClassifyInput:
    has_pr_url: bool
    pr: Optional[ClassifyPr]
    branch: Optional[str]
    last_activity_at: int  # epoch ms, freshest across the workstream's tasks
    now: int  # epoch ms; passed in so tests can pin time
    commits_ahead: Optional[int] = None  # working signal when there's no PR yet


def classify(input: ClassifyInput) -> set[SituationId]:
    """Classify a workstream into the set of situations it's in.

    Defensive — a missing signal just means its situation doesn't fire."""
    out: set[SituationId] = set()
    pr = input.pr

    if pr is not None:
        if pr.state in ("merged", "closed"):
            # `done` is exclusive — return early so we don't double-bucket.
            out.add("done")
            return out

        if pr.ci_status == "failing":
            out.add("ci_failing")
        if pr.review_decision == "changes_requested":
            out.add("changes_requested")
        if pr.unresolved_threads > 0 and pr.is_current_user_author:
            out.add("comments_waiting")
        if (
            pr.state == "open"
            and pr.ci_status == "passing"
            and pr.review_decision == "approved"
            and pr.mergeable is not False
        ):
            out.add("ready_to_merge")
        if pr.state in ("open", "draft"):
            out.add("in_review")
    elif input.has_pr_url:
        # PR URL stamped on a task but no PR data yet — treat as in review.
        out.add("in_review")
    elif input.branch:
        ahead = input.commits_ahead
        if ahead is None or ahead > 0:
            out.add("working")

    # `stale` stacks on top of anything except `done` (early-returned above).
    if input.now - input.last_activity_at > STALE_THRESHOLD_MS:
        out.add("stale")

    return out


def pick_primary_situation(situations: Iterable[SituationId]) -> Optional[SituationId]:
    present = set(situations)
    for sid in SITUATION_PRIORITY:
        if sid in present:
            return sid
    return None
