from posthog.models.subscription import Subscription
from posthog.sync import database_sync_to_async
from posthog.temporal.subscriptions.types import DeliverSubscriptionResult, RecipientResult

from ee.tasks.subscriptions import _capture_delivery_failed_event
from ee.tasks.subscriptions.auto_disable import DisableReason, disable_invalid_subscription


async def auto_disable_and_return(
    subscription: Subscription,
    reason: DisableReason,
    recipient_results: list[RecipientResult],
) -> DeliverSubscriptionResult:
    """Permanent-failure exit path: record per-recipient failure, capture analytics,
    and auto-disable the subscription. Shared by the insight/dashboard and AI delivery paths."""
    recipient_results.append(
        RecipientResult(
            recipient=subscription.target_value,
            status="failed",
            error={"message": reason.description, "type": reason.key},
        )
    )
    # `_capture_delivery_failed_event` only reads `str(e)` and `type(e).__name__`,
    # so a plain Exception conveys the same info without implying retry semantics.
    _capture_delivery_failed_event(subscription, Exception(reason.description))
    await database_sync_to_async(disable_invalid_subscription, thread_sensitive=False)(subscription, reason)
    return DeliverSubscriptionResult(recipient_results=recipient_results)
