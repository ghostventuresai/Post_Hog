import asyncio
import logging

from django.conf import settings

from temporalio.client import WorkflowAlreadyStartedError
from temporalio.common import WorkflowIDReusePolicy

from posthog.temporal.common.client import sync_connect

from products.tasks.backend.temporal.code_workstreams.workflow import EvaluateTeamCodeWorkstreamsInput

logger = logging.getLogger(__name__)


def trigger_team_code_workstreams_evaluation(team_id: int) -> bool:
    """Kick off an on-demand evaluation for one team (the Home "refresh" button).

    Coalesces: a deterministic id means a concurrent refresh for the same team
    is a no-op rather than a duplicate cycle. Returns True if a new run started.
    """
    client = sync_connect()
    workflow_id = f"evaluate-team-code-workstreams-ondemand-{team_id}"
    try:
        asyncio.run(
            client.start_workflow(
                "evaluate-team-code-workstreams",
                EvaluateTeamCodeWorkstreamsInput(team_id=team_id),
                id=workflow_id,
                id_reuse_policy=WorkflowIDReusePolicy.ALLOW_DUPLICATE,
                task_queue=settings.TASKS_TASK_QUEUE,
            )
        )
        return True
    except WorkflowAlreadyStartedError:
        logger.info("code_workstreams_refresh_already_running", extra={"team_id": team_id})
        return False
