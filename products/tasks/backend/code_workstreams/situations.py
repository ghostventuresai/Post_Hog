from typing import Literal, get_args

# Situation ids; the string values are the client-facing wire contract.
SituationId = Literal[
    "working",
    "in_review",
    "ci_failing",
    "changes_requested",
    "comments_waiting",
    "ready_to_merge",
    "stale",
    "done",
]

SITUATION_IDS: tuple[SituationId, ...] = get_args(SituationId)

# Priority for picking the primary situation when several apply — drives board
# column placement.
SITUATION_PRIORITY: tuple[SituationId, ...] = (
    "done",
    "ready_to_merge",
    "ci_failing",
    "changes_requested",
    "comments_waiting",
    "in_review",
    "working",
    "stale",
)

# Situations that escalate a workstream into the "needs attention" bucket on the
# list view; everything else falls into "in progress".
ATTENTION_SITUATIONS: frozenset[SituationId] = frozenset(
    {"ci_failing", "changes_requested", "comments_waiting", "stale"}
)
