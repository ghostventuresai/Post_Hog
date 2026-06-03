"""REST API for the PostHog Code "Home" surface.

Serves the per-user workflow config and the classified workstream snapshot the
client renders. Workstreams and PR state are produced server-side by the
`evaluate-code-workstreams` Temporal worker; these endpoints are cheap reads
over the persisted rows. Responses use camelCase wire shapes the client validates.
"""

from datetime import timedelta

from django.utils import timezone

from rest_framework import status, viewsets
from rest_framework.authentication import SessionAuthentication
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from posthog.api.routing import TeamAndOrgViewSetMixin
from posthog.auth import OAuthAccessTokenAuthentication, PersonalAPIKeyAuthentication
from posthog.permissions import APIScopePermission

from .code_workstreams.default_workflow import build_default_bindings
from .code_workstreams.validation import validate_bindings
from .models import CodeWorkflowConfig, CodeWorkstream, TaskRun

# A live run is only an "active agent" while it's been touched this recently.
ACTIVE_AGENT_WINDOW = timedelta(minutes=30)
RUNNING_STATUSES = (TaskRun.Status.QUEUED, TaskRun.Status.IN_PROGRESS)

_AUTH_CLASSES = [SessionAuthentication, PersonalAPIKeyAuthentication, OAuthAccessTokenAuthentication]


def _epoch_ms(dt) -> int:
    return int(dt.timestamp() * 1000)


def _serialize_diagnostic(d) -> dict:
    # Omit null situation/action ids — the client treats them as optional
    # (undefined), not nullable.
    out = {"severity": d.severity, "code": d.code, "message": d.message}
    if d.situation_id is not None:
        out["situationId"] = d.situation_id
    if d.action_id is not None:
        out["actionId"] = d.action_id
    return out


def _serialize_config(config: CodeWorkflowConfig) -> dict:
    return {
        "id": str(config.id),
        "version": config.version,
        "updatedAt": config.updated_at.isoformat(),
        "bindings": config.bindings,
    }


class CodeWorkflowViewSet(TeamAndOrgViewSetMixin, viewsets.ViewSet):
    """Per-user Home workflow: situation → quick-action bindings.

    GET    /code_workflow/        → WorkflowConfig (seeds the default on first read)
    POST   /code_workflow/save/   → { config, expectedVersion } → SaveResult (optimistic concurrency)
    POST   /code_workflow/reset/  → reseed default, returns WorkflowConfig
    """

    scope_object = "task"
    authentication_classes = _AUTH_CLASSES
    permission_classes = [IsAuthenticated, APIScopePermission]

    def _get_or_seed(self) -> CodeWorkflowConfig:
        config, _ = CodeWorkflowConfig.objects.get_or_create(
            team=self.team,
            user=self.request.user,
            defaults={"bindings": build_default_bindings(), "version": 1},
        )
        return config

    def list(self, request, *args, **kwargs):
        return Response(_serialize_config(self._get_or_seed()))

    @action(detail=False, methods=["post"], url_path="save", required_scopes=["task:write"])
    def save(self, request, **kwargs):
        config_in = request.data.get("config") or {}
        expected_version = request.data.get("expectedVersion")
        bindings = config_in.get("bindings") or {}

        current = self._get_or_seed()
        if not isinstance(expected_version, int) or current.version != expected_version:
            return Response(
                {"status": "conflict", "config": _serialize_config(current)},
                status=status.HTTP_409_CONFLICT,
            )

        result = validate_bindings(bindings)
        if not result.can_save:
            return Response(
                {
                    "status": "invalid",
                    "config": _serialize_config(current),
                    "diagnostics": [_serialize_diagnostic(d) for d in result.diagnostics],
                },
                status=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )

        current.bindings = bindings
        current.version = current.version + 1
        current.save(update_fields=["bindings", "version", "updated_at"])
        return Response({"status": "saved", "config": _serialize_config(current)})

    @action(detail=False, methods=["post"], url_path="reset", required_scopes=["task:write"])
    def reset(self, request, **kwargs):
        config = self._get_or_seed()
        config.bindings = build_default_bindings()
        config.version = config.version + 1
        config.save(update_fields=["bindings", "version", "updated_at"])
        return Response(_serialize_config(config))


class CodeHomeViewSet(TeamAndOrgViewSetMixin, viewsets.ViewSet):
    """The Home snapshot for the current user.

    GET   /code_home/          → HomeSnapshot { activeAgents, needsAttention, inProgress }
    POST  /code_home/refresh/  → kick off an on-demand worker evaluation (202)
    """

    scope_object = "task"
    authentication_classes = _AUTH_CLASSES
    permission_classes = [IsAuthenticated, APIScopePermission]

    def _serialize_workstream(self, ws: CodeWorkstream) -> dict:
        return {
            "id": ws.key,
            "repoName": ws.repo_name,
            "repoFullPath": ws.repo_full_path,
            "branch": ws.branch,
            "prUrl": ws.pr_url,
            "pr": ws.pr,
            "tasks": [
                {
                    "id": t.get("id"),
                    "title": t.get("title"),
                    "status": t.get("status"),
                    "isGenerating": False,
                    "needsPermission": False,
                }
                for t in (ws.tasks or [])
            ],
            "situations": ws.situations or [],
            "lastActivityAt": _epoch_ms(ws.last_activity_at),
        }

    def _active_agents(self) -> list[dict]:
        """Live agent strip — computed fresh from running TaskRuns, not persisted.

        A recent queued/in-progress run with no PR yet.
        """
        cutoff = timezone.now() - ACTIVE_AGENT_WINDOW
        runs = (
            TaskRun.objects.filter(
                team=self.team,
                task__created_by=self.request.user,
                task__archived=False,
                status__in=RUNNING_STATUSES,
                updated_at__gte=cutoff,
            )
            .select_related("task")
            .order_by("-updated_at")
        )

        seen_tasks: set[str] = set()
        agents: list[dict] = []
        for run in runs.iterator():
            task = run.task
            if str(task.id) in seen_tasks:
                continue
            if (run.output or {}).get("pr_url"):
                # Past the working stage — surfaces as a workstream, not the strip.
                continue
            seen_tasks.add(str(task.id))
            agents.append(
                {
                    "taskId": str(task.id),
                    "title": task.title,
                    "repoName": task.repository.split("/")[-1] if task.repository else None,
                    "branch": run.branch,
                    "status": run.status,
                    "lastActivityAt": _epoch_ms(run.updated_at),
                    "needsPermission": False,
                    "cloudPrUrl": None,
                }
            )
        return agents

    def list(self, request, *args, **kwargs):
        # Ordered by the DB (model Meta orders by -last_activity_at), so the two
        # buckets stay sorted without a Python sort.
        workstreams = CodeWorkstream.objects.filter(team=self.team, user=self.request.user)
        needs_attention = []
        in_progress = []
        for ws in workstreams.iterator():
            serialized = self._serialize_workstream(ws)
            if ws.state == CodeWorkstream.WorkstreamState.ATTENTION:
                needs_attention.append(serialized)
            else:
                in_progress.append(serialized)

        return Response(
            {
                "activeAgents": self._active_agents(),
                "needsAttention": needs_attention,
                "inProgress": in_progress,
            }
        )

    @action(detail=False, methods=["post"], url_path="refresh", required_scopes=["task:write"])
    def refresh(self, request, **kwargs):
        from .temporal.code_workstreams.client import trigger_team_code_workstreams_evaluation

        started = trigger_team_code_workstreams_evaluation(self.team.id)
        return Response({"started": started}, status=status.HTTP_202_ACCEPTED)
