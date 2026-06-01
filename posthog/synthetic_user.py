"""Lives outside posthog.auth to avoid a circular import when imported by posthog.hogql."""

from typing import Optional


class SyntheticUser:
    """Tagged base class for non-real principals authenticated via service tokens.

    Subclasses opt into:
      * `Database.create_for` hides all RBAC-scoped system tables
        (synthetic users are treated like anonymous requests, not real users).
      * `has_perm` / `has_module_perms` always return False; Django
        permission checks against a SyntheticUser silently deny.
      * `id` is None; do not use it as a foreign key. Use `current_team_id`.
    """

    email: Optional[str] = None
    is_staff: bool = False
    is_superuser: bool = False
    is_active: bool = True
    is_anonymous: bool = False
    groups: list = []
    user_permissions: list = []

    def __init__(self, team, distinct_id: str):
        self.team = team
        self.current_team_id = team.id
        self.is_authenticated = True
        self.pk = -1
        self.id: Optional[int] = None
        self.distinct_id = distinct_id

    def has_perm(self, perm, obj=None):
        return False

    def has_module_perms(self, app_label):
        return False
