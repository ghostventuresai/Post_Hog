from dataclasses import dataclass

from django.utils import timezone

from temporalio import activity

from posthog.temporal.common.utils import close_db_connections

from products.tasks.backend.models import TaskRun
from products.tasks.backend.temporal.code_workstreams.constants import ACTIVITY_WINDOW, MAX_TEAMS_PER_CYCLE


@dataclass
class ListActiveCodeTeamsOutput:
    team_ids: list[int]
    truncated: bool


@activity.defn
@close_db_connections
def list_active_code_teams(_: None = None) -> ListActiveCodeTeamsOutput:
    """Teams with recent code-task activity — the dispatcher's fan-out set.

    Ordered by id (stable) and capped so the dispatcher's history stays bounded;
    a truncation is logged rather than silently dropped."""
    cutoff = timezone.now() - ACTIVITY_WINDOW
    team_ids = list(
        TaskRun.objects.filter(updated_at__gte=cutoff).order_by("team_id").values_list("team_id", flat=True).distinct()
    )
    truncated = len(team_ids) > MAX_TEAMS_PER_CYCLE
    if truncated:
        activity.logger.warning(
            "code_workstreams_active_teams_truncated",
            total=len(team_ids),
            cap=MAX_TEAMS_PER_CYCLE,
        )
        team_ids = team_ids[:MAX_TEAMS_PER_CYCLE]
    return ListActiveCodeTeamsOutput(team_ids=team_ids, truncated=truncated)
