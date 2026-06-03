import pytest

from asgiref.sync import async_to_sync

from posthog.models.organization import Organization
from posthog.models.team.team import Team
from posthog.models.user import User

from products.tasks.backend.models import Task, TaskRun
from products.tasks.backend.temporal.process_task.activities.set_actor_on_run import (
    SetActorOnRunInput,
    set_actor_on_run,
)


def _make_task_run(state: dict | None = None) -> TaskRun:
    org = Organization.objects.create(name="TestOrg")
    team = Team.objects.create(organization=org, name="TestTeam")
    user = User.objects.create(email="alice@test.com")
    task = Task.objects.create(
        team=team,
        title="Test task",
        description="desc",
        origin_product=Task.OriginProduct.SLACK,
        created_by=user,
    )
    return TaskRun.objects.create(
        task=task,
        team=team,
        status=TaskRun.Status.IN_PROGRESS,
        state=state if state is not None else {"unrelated": "value"},
    )


@pytest.mark.django_db(transaction=True)
def test_set_actor_writes_to_state(activity_environment):
    task_run = _make_task_run()

    async_to_sync(activity_environment.run)(
        set_actor_on_run,
        SetActorOnRunInput(run_id=str(task_run.id), slack_user_id="ULATEST"),
    )

    task_run.refresh_from_db()
    assert task_run.state["acting_slack_user_id"] == "ULATEST"
    # Existing state keys must be preserved — this is a merge, not a replace.
    assert task_run.state["unrelated"] == "value"


@pytest.mark.django_db(transaction=True)
def test_set_actor_can_clear_with_none(activity_environment):
    task_run = _make_task_run(state={"acting_slack_user_id": "UOLD", "unrelated": "value"})

    async_to_sync(activity_environment.run)(
        set_actor_on_run,
        SetActorOnRunInput(run_id=str(task_run.id), slack_user_id=None),
    )

    task_run.refresh_from_db()
    assert task_run.state.get("acting_slack_user_id") is None
    assert task_run.state["unrelated"] == "value"
