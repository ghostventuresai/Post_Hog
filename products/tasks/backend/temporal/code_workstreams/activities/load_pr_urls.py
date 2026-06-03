from dataclasses import dataclass
from typing import Optional

from django.utils import timezone

from temporalio import activity

from posthog.models import Integration
from posthog.models.user_integration import UserIntegration
from posthog.temporal.common.utils import close_db_connections

from products.tasks.backend.models import TaskRun
from products.tasks.backend.temporal.code_workstreams.constants import ACTIVITY_WINDOW, MAX_PRS_PER_TEAM_PER_CYCLE


@dataclass
class PrRef:
    pr_url: str
    github_integration_id: Optional[int]
    github_user_integration_id: Optional[str]


@dataclass
class LoadTeamPrUrlsInput:
    team_id: int


@dataclass
class LoadTeamPrUrlsOutput:
    prs: list[PrRef]


@activity.defn
@close_db_connections
def load_team_pr_urls(input: LoadTeamPrUrlsInput) -> LoadTeamPrUrlsOutput:
    """Distinct PR URLs across the team's recent task runs, each tagged with the
    GitHub integration that can poll it. Deduped (first run wins) and capped.

    A task that wasn't explicitly linked to an integration (common for tasks
    created before GitHub was connected) falls back to the team's GitHub
    integration, then the task creator's user GitHub integration — so connecting
    either is enough for the PR to be polled."""
    cutoff = timezone.now() - ACTIVITY_WINDOW
    runs = (
        TaskRun.objects.filter(team_id=input.team_id, updated_at__gte=cutoff, output__pr_url__isnull=False)
        .select_related("task")
        .order_by("-updated_at")
    )

    team_github_id: Optional[int] = (
        Integration.objects.filter(team_id=input.team_id, kind="github").values_list("id", flat=True).first()
    )
    user_github_by_creator: dict[int, Optional[str]] = {}

    def creator_user_github(creator_id: Optional[int]) -> Optional[str]:
        if creator_id is None:
            return None
        if creator_id not in user_github_by_creator:
            uid = UserIntegration.objects.filter(user_id=creator_id, kind="github").values_list("id", flat=True).first()
            user_github_by_creator[creator_id] = str(uid) if uid else None
        return user_github_by_creator[creator_id]

    seen: dict[str, PrRef] = {}
    for run in runs.iterator():
        url = (run.output or {}).get("pr_url")
        if not url or url in seen:
            continue
        task = run.task
        team_int = task.github_integration_id
        user_int = str(task.github_user_integration_id) if task.github_user_integration_id else None
        if team_int is None and user_int is None:
            team_int = team_github_id
            if team_int is None:
                user_int = creator_user_github(task.created_by_id)
        seen[url] = PrRef(pr_url=url, github_integration_id=team_int, github_user_integration_id=user_int)
        if len(seen) >= MAX_PRS_PER_TEAM_PER_CYCLE:
            break

    return LoadTeamPrUrlsOutput(prs=list(seen.values()))
