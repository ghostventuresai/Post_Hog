from dataclasses import dataclass

from temporalio import activity

from posthog.temporal.common.utils import asyncify

from products.tasks.backend.models import TaskRun
from products.tasks.backend.temporal.observability import log_with_activity_context


@dataclass
class SetActorOnRunInput:
    run_id: str
    slack_user_id: str | None


@activity.defn
@asyncify
def set_actor_on_run(input: SetActorOnRunInput) -> None:
    """Stamp the Slack user id of whoever last engaged the agent onto the run's
    state, so the cross-workflow reply paths (``relay_slack_message`` and the
    PR-opened notification in ``post_slack_update``) can tag them instead of
    the original task author.

    Called by the task-processing workflow on bootstrap and on every
    ``set_current_actor`` signal. ``slack_user_id=None`` clears the field —
    used when the input carries no Slack context (e.g., non-Slack-originated
    runs).
    """
    log_with_activity_context(
        "Setting current actor on task run",
        run_id=input.run_id,
        slack_user_id=input.slack_user_id,
    )

    TaskRun.update_state_atomic(input.run_id, updates={"acting_slack_user_id": input.slack_user_id})
