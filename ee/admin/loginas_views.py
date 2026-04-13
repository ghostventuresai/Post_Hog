import json

from django.http import Http404, JsonResponse, QueryDict
from django.views.decorators.http import require_http_methods

import posthoganalytics
from loginas.utils import is_impersonated_session, restore_original_login
from loginas.views import user_login as loginas_user_login

from posthog.helpers.impersonation import get_original_user_from_session
from posthog.middleware import IMPERSONATION_READ_ONLY_SESSION_KEY, is_read_only_impersonation
from posthog.models import User


def loginas_user(request, user_id):
    staff_user = request.user
    response = loginas_user_login(request, user_id)

    if is_impersonated_session(request):
        is_read_only = request.POST.get("read_only") != "false"
        if is_read_only:
            request.session[IMPERSONATION_READ_ONLY_SESSION_KEY] = True

        target_user = User.objects.filter(id=user_id).first()
        posthoganalytics.capture(
            distinct_id=str(staff_user.distinct_id),
            event="impersonation_started",
            properties={
                "mode": "read_only" if is_read_only else "read_write",
                "reason": request.POST.get("reason", ""),
                "staff_user_id": staff_user.id,
                "staff_user_email": staff_user.email,
                "target_user_id": user_id,
                "target_user_email": target_user.email if target_user else None,
            },
        )

    return response


@require_http_methods(["POST"])
def switch_impersonation(request):
    """Switch to a different user during an existing impersonation session."""
    if not is_impersonated_session(request):
        raise Http404()

    staff_user = get_original_user_from_session(request)
    if not staff_user or not staff_user.is_staff:
        raise Http404()

    try:
        data = json.loads(request.body)
        target_user_id = data.get("user_id")
        reason = data.get("reason", "").strip()
        read_only = data.get("read_only", True)
    except (json.JSONDecodeError, AttributeError):
        return JsonResponse({"error": "Invalid request body"}, status=400)

    if not target_user_id or not reason:
        return JsonResponse({"error": "user_id and reason are required"}, status=400)

    # Save current state so we can roll back on failure
    previous_target = request.user
    was_read_only = is_read_only_impersonation(request)

    # End the current impersonation, restoring the staff user session
    restore_original_login(request)

    # Set POST data so loginas_user can read it (it expects form-encoded data)
    post_data = QueryDict(mutable=True)
    post_data["read_only"] = "true" if read_only else "false"
    post_data["reason"] = reason
    request.POST = post_data

    # Delegate to the standard loginas_user flow (includes CAN_LOGIN_AS
    # validation, read-only flag, and analytics capture)
    loginas_user(request, str(target_user_id))

    if not is_impersonated_session(request):
        # Switch failed — re-impersonate the previous user with their
        # original mode so we don't silently change the session state
        rollback_data = QueryDict(mutable=True)
        rollback_data["read_only"] = "true" if was_read_only else "false"
        rollback_data["reason"] = "rollback after failed switch"
        request.POST = rollback_data
        loginas_user(request, str(previous_target.id))
        return JsonResponse({"error": "Failed to switch user"}, status=400)

    return JsonResponse({"success": True})


@require_http_methods(["POST"])
def upgrade_impersonation(request):
    """Upgrade from read-only to read-write impersonation"""
    if not is_impersonated_session(request) or not is_read_only_impersonation(request):
        raise Http404()

    try:
        data = json.loads(request.body)
        reason = data.get("reason", "").strip()
    except (json.JSONDecodeError, AttributeError):
        reason = ""

    if not reason:
        return JsonResponse({"error": "A reason is required to upgrade impersonation"}, status=400)

    staff_user = get_original_user_from_session(request)
    if not staff_user or not staff_user.is_staff:
        return JsonResponse({"error": "Unable to upgrade impersonation"}, status=400)

    if IMPERSONATION_READ_ONLY_SESSION_KEY in request.session:
        del request.session[IMPERSONATION_READ_ONLY_SESSION_KEY]
    request.session.modified = True

    posthoganalytics.capture(
        distinct_id=str(staff_user.distinct_id),
        event="impersonation_upgraded",
        properties={
            "staff_user_id": staff_user.id,
            "staff_user_email": staff_user.email,
            "target_user_id": request.user.id,
            "target_user_email": request.user.email,
            "reason": reason,
        },
    )

    return JsonResponse({"success": True})
