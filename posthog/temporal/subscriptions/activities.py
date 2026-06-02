import json
import uuid
import typing
import datetime as dt
from datetime import datetime

from django.utils import timezone as tz

import temporalio.activity
from slack_sdk.errors import SlackApiError
from structlog import get_logger
from temporalio.exceptions import ApplicationError

from posthog.exceptions_capture import capture_exception
from posthog.models.exported_asset import ExportedAsset
from posthog.models.insight import Insight
from posthog.models.subscription import Subscription, SubscriptionDelivery
from posthog.sync import database_sync_to_async
from posthog.temporal.subscriptions.ai_subscription.delivery import (
    SlackIntegrationMissingError,
    generate_ai_subscription_markdown,
    send_email_ai_subscription_report,
    send_slack_ai_subscription_report,
)
from posthog.temporal.subscriptions.ai_subscription.spec_generator import PromptRejectedError
from posthog.temporal.subscriptions.insight_snapshot import (
    build_initial_content_snapshot,
    build_insight_delivery_snapshot,
)
from posthog.temporal.subscriptions.types import (
    CreateDeliveryRecordInputs,
    CreateExportAssetsInputs,
    CreateExportAssetsResult,
    DeliverSubscriptionInputs,
    DeliverSubscriptionResult,
    FetchDueSubscriptionsActivityInputs,
    GenerateAIReportInputs,
    GenerateAIReportResult,
    RecipientResult,
    SubscriptionAbortInfo,
    SubscriptionInfo,
    UpdateDeliveryRecordInputs,
)

from products.dashboards.backend.models.dashboard_tile import DashboardTile

from ee.tasks.subscriptions import SLACK_USER_CONFIG_ERRORS, _capture_delivery_failed_event
from ee.tasks.subscriptions.auto_disable import (
    AI_CONSENT_REVOKED_DISABLE_REASON,
    AI_PROMPT_INVALID_DISABLE_REASON,
    SLACK_DISCONNECTED_DISABLE_REASON,
    SLACK_PERMISSION_REVOKED_DISABLE_REASON,
    UNSUPPORTED_TARGET_DISABLE_REASON,
    DisableReason,
    disable_invalid_subscription,
    get_subscription_disable_reason,
)
from ee.tasks.subscriptions.email_subscriptions import send_email_subscription_report
from ee.tasks.subscriptions.slack_subscriptions import (
    get_slack_integration_for_team,
    send_slack_message_with_integration_async,
)

LOGGER = get_logger(__name__)

# Used only as the recipient_results error message — `no_assets` doesn't auto-disable
# (it indicates a transient resolve failure that retries can recover from).
NO_ASSETS_REASON = "No assets to deliver — likely a transient export pipeline failure; will retry on next schedule"

# `SubscriptionDelivery.content_snapshot` key the AI report markdown is written
# under by `generate_ai_subscription_report` and read back by `deliver_subscription`.
# This is the generate -> deliver handoff: the markdown can exceed Temporal's ~2 MiB
# payload cap, so it travels through Postgres by reference rather than on the wire —
# the same pattern insight snapshots use.
AI_REPORT_SNAPSHOT_KEY = "ai_report"


async def _load_ai_report(delivery_id: uuid.UUID) -> str | None:
    @database_sync_to_async(thread_sensitive=False)
    def _read() -> str | None:
        # DoesNotExist is tolerated here (read side): a missing row just means "no report yet".
        try:
            snapshot = SubscriptionDelivery.objects.values_list("content_snapshot", flat=True).get(pk=delivery_id)
        except SubscriptionDelivery.DoesNotExist:
            return None
        if not isinstance(snapshot, dict):
            return None
        report = snapshot.get(AI_REPORT_SNAPSHOT_KEY)
        return report if isinstance(report, str) and report else None

    return await _read()


async def _persist_ai_report(delivery_id: uuid.UUID, markdown: str) -> None:
    @database_sync_to_async(thread_sensitive=False)
    def _write() -> None:
        # No DoesNotExist guard: create_delivery_record always writes this row before
        # generation runs, so a missing row is a wiring bug — let it raise loudly.
        delivery = SubscriptionDelivery.objects.get(pk=delivery_id)
        delivery.content_snapshot = {**(delivery.content_snapshot or {}), AI_REPORT_SNAPSHOT_KEY: markdown}
        delivery.save(update_fields=["content_snapshot", "last_updated_at"])

    await _write()


async def _persist_content_snapshot(
    *,
    delivery_id: uuid.UUID,
    total_insight_count: int,
    insight_snapshots: list[dict[str, typing.Any]],
) -> int:
    """Merge insight snapshots onto SubscriptionDelivery.content_snapshot.

    Returns the serialized size of the insight_snapshots payload so callers can
    log it — the whole point of owning this write is staying under size cliffs,
    so measuring proximity to the next one is worth the cycles.
    """
    snapshot_bytes = len(json.dumps(insight_snapshots, default=str).encode("utf-8"))

    @database_sync_to_async(thread_sensitive=False)
    def _merge() -> None:
        delivery = SubscriptionDelivery.objects.get(pk=delivery_id)
        delivery.content_snapshot = {
            **(delivery.content_snapshot or {}),
            "total_insight_count": total_insight_count,
            "insights": insight_snapshots,
        }
        delivery.save(update_fields=["content_snapshot", "last_updated_at"])

    await _merge()
    return snapshot_bytes


@temporalio.activity.defn
async def fetch_due_subscriptions_activity(inputs: FetchDueSubscriptionsActivityInputs) -> list[SubscriptionInfo]:
    now_with_buffer = dt.datetime.utcnow() + dt.timedelta(minutes=inputs.buffer_minutes)
    await LOGGER.ainfo("Fetching due subscriptions", deadline=now_with_buffer)

    @database_sync_to_async(thread_sensitive=False)
    def get_subscriptions() -> list[SubscriptionInfo]:
        return [
            SubscriptionInfo(
                subscription_id=sub["id"],
                team_id=sub["team_id"],
                distinct_id=str(sub["created_by__distinct_id"])
                if sub["created_by__distinct_id"]
                else str(sub["team_id"]),
                next_delivery_date=sub["next_delivery_date"].isoformat() if sub["next_delivery_date"] else None,
                resource_type=Subscription.derive_resource_type(sub["insight_id"], sub["dashboard_id"], sub["prompt"]),
            )
            for sub in Subscription.objects.filter(next_delivery_date__lte=now_with_buffer, deleted=False, enabled=True)
            .exclude(dashboard__deleted=True)
            .exclude(insight__deleted=True)
            .values(
                "id", "team_id", "created_by__distinct_id", "next_delivery_date", "insight_id", "dashboard_id", "prompt"
            )
        ]

    subscriptions = await get_subscriptions()
    await LOGGER.ainfo("Fetched due subscriptions", count=len(subscriptions))

    return subscriptions


@temporalio.activity.defn
async def validate_subscription_for_delivery(subscription_id: int) -> SubscriptionAbortInfo | None:
    """Returns abort info when delivery should not proceed; None to continue."""
    subscription = await database_sync_to_async(
        Subscription.objects.select_related("created_by", "integration").get,
        thread_sensitive=False,
    )(pk=subscription_id)

    # Idempotency: a Temporal redispatch (e.g. worker crash mid-acknowledge) after a
    # prior auto-disable committed must not re-fire side effects.
    if not subscription.enabled:
        await LOGGER.ainfo("validate_subscription.already_disabled_skipping", subscription_id=subscription_id)
        return SubscriptionAbortInfo()

    reason = get_subscription_disable_reason(subscription.target_type, subscription.integration_id)
    if reason is None:
        return None

    LOGGER.warning(
        "validate_subscription.invalid_auto_disabling",
        subscription_id=subscription_id,
        target_type=subscription.target_type,
        reason=reason.key,
    )
    _capture_delivery_failed_event(subscription, Exception(reason.description))
    await database_sync_to_async(disable_invalid_subscription, thread_sensitive=False)(subscription, reason)
    return SubscriptionAbortInfo(
        failed_recipient=RecipientResult(
            recipient=subscription.target_value,
            status="failed",
            error={"message": reason.description, "type": reason.key},
        )
    )


@temporalio.activity.defn
async def create_export_assets(inputs: CreateExportAssetsInputs) -> CreateExportAssetsResult:
    await LOGGER.ainfo(
        "create_export_assets.starting",
        subscription_id=inputs.subscription_id,
    )

    subscription = await database_sync_to_async(
        Subscription.objects.select_related("created_by", "insight", "dashboard", "team").get,
        thread_sensitive=False,
    )(pk=inputs.subscription_id)

    team = subscription.team
    dashboard = subscription.dashboard

    await LOGGER.ainfo(
        "create_export_assets.loaded",
        subscription_id=inputs.subscription_id,
        has_dashboard=bool(dashboard),
        has_insight=bool(subscription.insight_id),
        target_type=subscription.target_type,
    )

    # Early exit if target value hasn't changed — avoids creating orphaned assets
    # for subs whose payload is identical to the previous delivery.
    if inputs.previous_value is not None and subscription.target_value == inputs.previous_value:
        await LOGGER.ainfo(
            "create_export_assets.no_change_skipping",
            subscription_id=inputs.subscription_id,
        )
        return CreateExportAssetsResult(
            exported_asset_ids=[],
            total_insight_count=0,
            team_id=team.id,
        )

    if dashboard:
        tiles = await database_sync_to_async(
            lambda: list(
                dashboard.tiles.select_related("insight").filter(insight__isnull=False, insight__deleted=False).all()
            ),
            thread_sensitive=False,
        )()
        tiles.sort(
            key=lambda x: (
                (x.layouts or {}).get("sm", {}).get("y", 100),
                (x.layouts or {}).get("sm", {}).get("x", 100),
            )
        )
        tile_insight_pairs: list[tuple[DashboardTile | None, Insight]] = [
            (tile, tile.insight) for tile in tiles if tile.insight
        ]

        selected_ids = await database_sync_to_async(
            lambda: (
                set(subscription.dashboard_export_insights.values_list("id", flat=True))
                if subscription.dashboard_export_insights.exists()
                else None
            ),
            thread_sensitive=False,
        )()
        if selected_ids:
            tile_insight_pairs = [(t, i) for t, i in tile_insight_pairs if i.id in selected_ids]
    elif subscription.insight:
        tile_insight_pairs = [(None, subscription.insight)]
    else:
        raise Exception("There are no insights to be sent for this Subscription")

    total_insight_count = len(tile_insight_pairs)
    export_pairs = tile_insight_pairs[: inputs.max_asset_count]

    expiry = ExportedAsset.compute_expires_after(ExportedAsset.ExportFormat.PNG)
    assets = [
        ExportedAsset(
            team=team,
            export_format=ExportedAsset.ExportFormat.PNG,
            insight=insight,
            dashboard=dashboard,
            expires_after=expiry,
        )
        for _tile, insight in export_pairs
    ]
    await database_sync_to_async(ExportedAsset.objects.bulk_create, thread_sensitive=False)(assets)

    @database_sync_to_async(thread_sensitive=False)
    def build_insight_snapshots() -> list[dict[str, typing.Any]]:
        return [
            build_insight_delivery_snapshot(
                insight=insight,
                team=team,
                dashboard=dashboard,
                tile=tile,
                user=subscription.created_by,
            )
            for tile, insight in export_pairs
        ]

    insight_snapshots = await build_insight_snapshots()

    # Persist insight snapshots directly on SubscriptionDelivery.content_snapshot
    # instead of returning them across the Temporal activity boundary — per-insight
    # query_results can reach multi-MB and will trip Temporal's ~2 MiB payload cap.
    # Standalone callers (tests, management commands) that don't pass delivery_id
    # skip the persist — they don't have a row to write to.
    target_delivery_id = inputs.delivery_id
    if target_delivery_id is not None:
        snapshot_bytes = await _persist_content_snapshot(
            delivery_id=target_delivery_id,
            total_insight_count=total_insight_count,
            insight_snapshots=insight_snapshots,
        )
        await LOGGER.ainfo(
            "create_export_assets.content_snapshot_persisted",
            subscription_id=inputs.subscription_id,
            delivery_id=str(target_delivery_id),
            insight_count=len(insight_snapshots),
            snapshot_bytes=snapshot_bytes,
        )

    await LOGGER.ainfo(
        "create_export_assets.assets_created",
        subscription_id=inputs.subscription_id,
        asset_count=len(assets),
        total_insights=total_insight_count,
    )
    return CreateExportAssetsResult(
        exported_asset_ids=[a.id for a in assets],
        total_insight_count=total_insight_count,
        team_id=team.id,
        distinct_id=str(subscription.created_by.distinct_id) if subscription.created_by else str(team.id),
        target_type=subscription.target_type,
    )


async def _auto_disable_and_return(
    subscription: Subscription,
    reason: DisableReason,
    recipient_results: list[RecipientResult],
) -> DeliverSubscriptionResult:
    """Permanent-failure exit path: record per-recipient failure, capture analytics,
    and auto-disable the subscription."""
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


@temporalio.activity.defn
async def deliver_subscription(inputs: DeliverSubscriptionInputs) -> DeliverSubscriptionResult:
    recipient_results: list[RecipientResult] = []

    subscription = await database_sync_to_async(
        Subscription.objects.select_related("created_by", "insight", "dashboard", "team", "integration").get,
        thread_sensitive=False,
    )(pk=inputs.subscription_id)

    # Activity-retry idempotency: if a previous attempt already auto-disabled this
    # subscription (UPDATE committed) and Temporal redispatched the activity (e.g.
    # worker crash mid-acknowledge), don't re-fire the disable side effects — UUID4
    # campaign keys mean MessagingRecord wouldn't dedup the duplicate email.
    if not subscription.enabled:
        LOGGER.info("deliver_subscription.skipped_disabled", subscription_id=inputs.subscription_id)
        return DeliverSubscriptionResult(recipient_results=[])

    await LOGGER.ainfo(
        "deliver_subscription.starting",
        subscription_id=inputs.subscription_id,
        target_type=subscription.target_type,
        asset_count=len(inputs.exported_asset_ids),
        is_new=inputs.is_new_subscription_target,
        resource_type=subscription.resource_type,
    )

    if subscription.resource_type == Subscription.ResourceType.AI_PROMPT:
        return await _deliver_ai_subscription(subscription, inputs, recipient_results)

    if (
        get_subscription_disable_reason(subscription.target_type, subscription.integration_id)
        == UNSUPPORTED_TARGET_DISABLE_REASON
    ):
        LOGGER.warning(
            "deliver_subscription.unsupported_target",
            subscription_id=inputs.subscription_id,
            target_type=subscription.target_type,
        )
        return await _auto_disable_and_return(subscription, UNSUPPORTED_TARGET_DISABLE_REASON, recipient_results)

    assets_by_id = await database_sync_to_async(
        lambda: {
            a.id: a
            for a in ExportedAsset.objects_including_ttl_deleted.select_related("insight", "dashboard").filter(
                pk__in=inputs.exported_asset_ids
            )
        },
        thread_sensitive=False,
    )()
    # Preserve the order from create_export_assets (sorted by dashboard tile layout)
    assets = [assets_by_id[aid] for aid in inputs.exported_asset_ids if aid in assets_by_id]

    if not assets:
        # Empty here means non-empty exported_asset_ids didn't resolve from DB — a
        # transient condition (TTL sweep, prior export crash, S3 race). Genuine
        # deletion is filtered upstream in create_export_assets and the workflow
        # short-circuits to SKIPPED before this activity runs. Don't auto-disable;
        # the failure is observable via the `subscription_delivery_failed` analytics
        # event and the next scheduled delivery retries.
        LOGGER.warning("deliver_subscription.no_assets", subscription_id=inputs.subscription_id)
        recipient_results.append(
            RecipientResult(
                recipient=subscription.target_value,
                status="failed",
                error={"message": NO_ASSETS_REASON, "type": "no_assets"},
            )
        )
        # Plain Exception — `_capture_delivery_failed_event` only reads `str(e)` and
        # `type(e).__name__`, and the activity returns cleanly so retry semantics on
        # ApplicationError would be misleading (matches `_auto_disable_and_return`).
        _capture_delivery_failed_event(subscription, Exception(NO_ASSETS_REASON))
        return DeliverSubscriptionResult(recipient_results=recipient_results)

    if subscription.target_type == "email":
        emails = subscription.target_value.split(",")
        await LOGGER.ainfo(
            "deliver_subscription.sending_email",
            subscription_id=inputs.subscription_id,
            recipient_count=len(emails),
        )
        if inputs.is_new_subscription_target:
            previous_emails = inputs.previous_value.split(",") if inputs.previous_value else []
            emails = list(set(emails) - set(previous_emails))

        last_error: Exception | None = None
        success_count = 0
        for email in emails:
            try:
                await database_sync_to_async(send_email_subscription_report, thread_sensitive=False)(
                    email,
                    subscription,
                    assets,
                    invite_message=inputs.invite_message or "" if inputs.is_new_subscription_target else None,
                    total_asset_count=inputs.total_insight_count,
                    send_async=False,
                    change_summary=inputs.change_summary,
                )
                success_count += 1
                recipient_results.append(RecipientResult(recipient=email, status="success"))
            except Exception as e:
                _capture_delivery_failed_event(subscription, e)
                LOGGER.error(
                    "deliver_subscription.email_failed",
                    subscription_id=subscription.id,
                    email=email,
                    next_delivery_date=subscription.next_delivery_date,
                    destination=subscription.target_type,
                    exc_info=True,
                )
                capture_exception(e)
                last_error = e
                recipient_results.append(
                    RecipientResult(
                        recipient=email,
                        status="failed",
                        error={"message": str(e), "type": type(e).__name__},
                    )
                )

        await LOGGER.ainfo(
            "deliver_subscription.email_complete",
            subscription_id=inputs.subscription_id,
            success_count=success_count,
            total_count=len(emails),
        )

        # Only retry if ALL recipients failed — partial success is acceptable
        # to avoid duplicate sends to already-delivered recipients
        if last_error is not None and success_count == 0:
            raise last_error

    elif subscription.target_type == "slack":
        try:
            integration = subscription.integration
            if integration is None:
                integration = await database_sync_to_async(get_slack_integration_for_team, thread_sensitive=False)(
                    subscription.team_id
                )
            elif integration.kind != "slack":
                LOGGER.warn(
                    "deliver_subscription.invalid_integration_kind",
                    subscription_id=subscription.id,
                    integration_id=integration.id,
                    kind=integration.kind,
                )
                integration = await database_sync_to_async(get_slack_integration_for_team, thread_sensitive=False)(
                    subscription.team_id
                )

            if not integration:
                LOGGER.warning(
                    "deliver_subscription.no_slack_integration",
                    subscription_id=inputs.subscription_id,
                )
                # Slack integration disconnected — auto-disable, mirrors the alert pattern.
                return await _auto_disable_and_return(
                    subscription, SLACK_DISCONNECTED_DISABLE_REASON, recipient_results
                )

            LOGGER.info("deliver_subscription.sending_slack_message", subscription_id=subscription.id)
            delivery_result = await send_slack_message_with_integration_async(
                integration,
                subscription,
                assets,
                total_asset_count=inputs.total_insight_count,
                is_new_subscription=inputs.is_new_subscription_target,
                change_summary=inputs.change_summary,
            )

            if delivery_result.is_complete_success:
                await LOGGER.ainfo(
                    "deliver_subscription.slack_sent",
                    subscription_id=inputs.subscription_id,
                )
                recipient_results.append(RecipientResult(recipient=subscription.target_value, status="success"))
            elif delivery_result.is_partial_failure:
                await LOGGER.awarning(
                    "deliver_subscription.slack_partial_failure",
                    subscription_id=inputs.subscription_id,
                    failed_thread_count=len(delivery_result.failed_thread_message_indices),
                    total_thread_count=delivery_result.total_thread_messages,
                )
                recipient_results.append(
                    RecipientResult(
                        recipient=subscription.target_value,
                        status="partial",
                        error={
                            "message": f"{len(delivery_result.failed_thread_message_indices)} thread message(s) failed",
                            "type": "partial_thread_failure",
                        },
                    )
                )

        except ApplicationError:
            raise
        except Exception as e:
            slack_error_code = e.response.get("error") if isinstance(e, SlackApiError) else None
            is_user_config_error = slack_error_code in SLACK_USER_CONFIG_ERRORS
            _capture_delivery_failed_event(subscription, e)
            LOGGER.error(
                "deliver_subscription.slack_failed",
                subscription_id=subscription.id,
                next_delivery_date=subscription.next_delivery_date,
                destination=subscription.target_type,
                exc_info=True,
            )
            capture_exception(e)
            if is_user_config_error:
                # Won't self-heal without user action — auto-disable so the subscription
                # stops re-firing every cycle.
                return await _auto_disable_and_return(
                    subscription, SLACK_PERMISSION_REVOKED_DISABLE_REASON, recipient_results
                )
            raise  # Transient Slack errors — let Temporal retry

    await LOGGER.ainfo(
        "deliver_subscription.completed",
        subscription_id=inputs.subscription_id,
        target_type=subscription.target_type,
    )
    return DeliverSubscriptionResult(recipient_results=recipient_results)


@temporalio.activity.defn
async def generate_ai_subscription_report(inputs: GenerateAIReportInputs) -> GenerateAIReportResult:
    # The "decide what to send" phase, split from delivery so the LLM runs once up front with
    # its own retry policy. Terminal failures (consent revoked, prompt invalid) auto-disable and
    # return aborted=True; transient errors bubble up for the activity's Temporal retry.
    subscription = await database_sync_to_async(
        Subscription.objects.select_related("created_by", "team", "team__organization").get,
        thread_sensitive=False,
    )(pk=inputs.subscription_id)

    # Idempotency on Temporal redispatch: if a prior attempt already produced the report,
    # don't re-bill the LLM — the point of the generate -> deliver split is one LLM run.
    if await _load_ai_report(inputs.delivery_id) is not None:
        await LOGGER.ainfo("generate_ai_subscription_report.already_generated", subscription_id=subscription.id)
        return GenerateAIReportResult(aborted=False)

    # Consent is gated once here, before any LLM cost — creation-time gates don't catch an
    # org that revokes AI-data-processing approval later. Auto-disable so it stops re-firing.
    if not subscription.team.organization.is_ai_data_processing_approved:
        LOGGER.warning("generate_ai_subscription_report.consent_revoked", subscription_id=subscription.id)
        aborted = await _auto_disable_and_return(subscription, AI_CONSENT_REVOKED_DISABLE_REASON, [])
        return GenerateAIReportResult(aborted=True, recipient_results=aborted.recipient_results)

    try:
        markdown = await generate_ai_subscription_markdown(subscription)
    except PromptRejectedError as exc:
        # Structurally permanent: no creator, prompt now fails sanitization, or the
        # planner returned a malformed plan. Re-firing wastes LLM tokens every cycle.
        LOGGER.warning(
            "generate_ai_subscription_report.prompt_rejected",
            subscription_id=subscription.id,
            reason=str(exc),
        )
        _capture_delivery_failed_event(subscription, exc)
        # Seed a recipient result with the exception detail first — it carries planner
        # context that the disable reason (appended next by `_auto_disable_and_return`)
        # doesn't.
        recipient_results = [
            RecipientResult(
                recipient=subscription.target_value,
                status="failed",
                error={"message": str(exc), "type": "PromptRejectedError"},
            )
        ]
        aborted = await _auto_disable_and_return(subscription, AI_PROMPT_INVALID_DISABLE_REASON, recipient_results)
        return GenerateAIReportResult(aborted=True, recipient_results=aborted.recipient_results)

    await _persist_ai_report(inputs.delivery_id, markdown)
    return GenerateAIReportResult(aborted=False)


async def _deliver_ai_subscription(
    subscription: Subscription,
    inputs: DeliverSubscriptionInputs,
    recipient_results: list[RecipientResult],
) -> DeliverSubscriptionResult:
    # Ships the report generate_ai_subscription_report already produced (read back from the
    # delivery row) — no LLM work here. Transient send errors retry; terminal Slack errors auto-disable.
    if inputs.delivery_id is None:
        # The AI workflow always creates the delivery row and runs generation before
        # delivery, so a missing reference is a wiring bug, not a runtime state.
        raise ApplicationError(f"AI delivery for subscription {subscription.id} has no delivery_id", non_retryable=True)

    markdown = await _load_ai_report(inputs.delivery_id)
    if markdown is None:
        # Generation persists the report before delivery is scheduled, so a missing report
        # means the row was lost. Non-retryable: re-running *delivery* can't regenerate the
        # report, so retrying just burns attempts — fail loud rather than ship an empty report.
        raise ApplicationError(
            f"AI report missing for subscription {subscription.id} (delivery {inputs.delivery_id})",
            non_retryable=True,
        )

    if subscription.target_type == Subscription.SubscriptionTarget.EMAIL:
        return await _deliver_ai_email(subscription, inputs, markdown, recipient_results)
    if subscription.target_type == Subscription.SubscriptionTarget.SLACK:
        return await _deliver_ai_slack(subscription, markdown, recipient_results)
    # `validate_subscription_for_delivery` auto-disables unsupported targets up front,
    # so reaching here means an invariant was violated.
    raise ApplicationError(
        f"AI delivery reached an unsupported target {subscription.target_type!r}", non_retryable=True
    )


async def _deliver_ai_email(
    subscription: Subscription,
    inputs: DeliverSubscriptionInputs,
    markdown: str,
    recipient_results: list[RecipientResult],
) -> DeliverSubscriptionResult:
    emails = [e.strip() for e in subscription.target_value.split(",") if e.strip()]
    if inputs.is_new_subscription_target and inputs.previous_value is not None:
        previous_emails = {e.strip() for e in inputs.previous_value.split(",") if e.strip()}
        emails = [e for e in emails if e not in previous_emails]
    # workflow_run_id disambiguates the MessagingRecord dedup key: stable across activity
    # retries within one run (a scheduled tick dedups its own retries) but unique per run,
    # so a fresh "Test delivery" click (new workflow run) gets a fresh key and sends.
    # Always set inside a Temporal activity, but typed Optional by the SDK.
    workflow_run_id = temporalio.activity.info().workflow_run_id
    if workflow_run_id is None:
        raise ApplicationError("AI email delivery requires a workflow run id", non_retryable=True)

    success_count = 0
    last_error: Exception | None = None
    for email in emails:
        try:
            await database_sync_to_async(send_email_ai_subscription_report, thread_sensitive=False)(
                email=email,
                subscription=subscription,
                markdown=markdown,
                delivery_run_id=workflow_run_id,
            )
            recipient_results.append(RecipientResult(recipient=email, status="success", error=None))
            success_count += 1
        except Exception as exc:
            # One bad recipient shouldn't fail the others (matches the non-AI path).
            LOGGER.error(
                "deliver_subscription.ai_email_failed", subscription_id=subscription.id, email=email, exc_info=True
            )
            capture_exception(exc)
            _capture_delivery_failed_event(subscription, exc)
            recipient_results.append(
                RecipientResult(
                    recipient=email, status="failed", error={"message": str(exc), "type": type(exc).__name__}
                )
            )
            last_error = exc
    # If every recipient failed, raise so Temporal retries — the report is already
    # persisted, so the retry re-sends without re-running the LLM pipeline.
    if last_error is not None and success_count == 0:
        raise last_error
    return DeliverSubscriptionResult(recipient_results=recipient_results)


async def _deliver_ai_slack(
    subscription: Subscription,
    markdown: str,
    recipient_results: list[RecipientResult],
) -> DeliverSubscriptionResult:
    try:
        await send_slack_ai_subscription_report(subscription=subscription, markdown=markdown)
        recipient_results.append(RecipientResult(recipient=subscription.target_value, status="success", error=None))
        return DeliverSubscriptionResult(recipient_results=recipient_results)
    except SlackIntegrationMissingError as exc:
        # Integration was disconnected since the user's last edit; auto-disable rather
        # than re-firing into a silent no-op every cycle.
        LOGGER.warning("deliver_subscription.ai_slack_no_integration", subscription_id=subscription.id)
        _capture_delivery_failed_event(subscription, exc)
        return await _auto_disable_and_return(subscription, SLACK_DISCONNECTED_DISABLE_REASON, recipient_results)
    except Exception as exc:
        slack_error_code = exc.response.get("error") if isinstance(exc, SlackApiError) else None
        is_user_config_error = slack_error_code in SLACK_USER_CONFIG_ERRORS
        LOGGER.error(
            "deliver_subscription.ai_slack_failed",
            subscription_id=subscription.id,
            slack_error=slack_error_code,
            exc_info=True,
        )
        capture_exception(exc)
        _capture_delivery_failed_event(subscription, exc)
        if is_user_config_error:
            # Won't self-heal without user action — auto-disable so it stops re-firing.
            return await _auto_disable_and_return(
                subscription, SLACK_PERMISSION_REVOKED_DISABLE_REASON, recipient_results
            )
        raise  # Transient Slack errors — let Temporal retry


@temporalio.activity.defn
async def create_delivery_record(inputs: CreateDeliveryRecordInputs) -> uuid.UUID:
    scheduled_at = datetime.fromisoformat(inputs.scheduled_at) if inputs.scheduled_at else None

    @database_sync_to_async(thread_sensitive=False)
    def _create() -> uuid.UUID:
        subscription = Subscription.objects.select_related("insight", "dashboard").get(pk=inputs.subscription_id)
        if subscription.team_id != inputs.team_id:
            raise ValueError(
                f"Subscription team_id ({subscription.team_id}) does not match inputs.team_id ({inputs.team_id})"
            )

        content_snapshot = build_initial_content_snapshot(subscription)

        delivery, _created = SubscriptionDelivery.objects.get_or_create(
            idempotency_key=inputs.idempotency_key,
            defaults={
                "subscription": subscription,
                "team_id": inputs.team_id,
                "temporal_workflow_id": inputs.temporal_workflow_id,
                "trigger_type": inputs.trigger_type,
                "scheduled_at": scheduled_at,
                "target_type": subscription.target_type,
                "target_value": subscription.target_value,
                "content_snapshot": content_snapshot,
                "status": SubscriptionDelivery.Status.STARTING,
            },
        )
        return delivery.id

    delivery_id = await _create()
    await LOGGER.ainfo(
        "create_delivery_record.created",
        subscription_id=inputs.subscription_id,
        delivery_id=delivery_id,
    )
    return delivery_id


@temporalio.activity.defn
async def update_delivery_record(inputs: UpdateDeliveryRecordInputs) -> None:
    @database_sync_to_async(thread_sensitive=False)
    def _update() -> None:
        delivery = SubscriptionDelivery.objects.get(pk=inputs.delivery_id)
        update_fields: list[str] = ["status", "last_updated_at"]
        delivery.status = inputs.status

        if inputs.exported_asset_ids is not None:
            delivery.exported_asset_ids = inputs.exported_asset_ids
            update_fields.append("exported_asset_ids")
        if inputs.recipient_results is not None:
            delivery.recipient_results = inputs.recipient_results
            update_fields.append("recipient_results")
        if inputs.change_summary is not None:
            delivery.change_summary = inputs.change_summary
            update_fields.append("change_summary")
        delivery.error = inputs.error
        update_fields.append("error")
        if inputs.finished:
            delivery.finished_at = tz.now()
            update_fields.append("finished_at")

        delivery.save(update_fields=update_fields)

    await _update()
    await LOGGER.ainfo(
        "update_delivery_record.updated",
        delivery_id=inputs.delivery_id,
        status=inputs.status,
    )


@temporalio.activity.defn
async def advance_next_delivery_date(subscription_id: int) -> None:
    subscription = await database_sync_to_async(Subscription.objects.get, thread_sensitive=False)(pk=subscription_id)
    # Disabled subs (e.g. auto-disabled this run / paused by user) don't get a
    # future delivery date — avoids showing a misleading "next delivery" in the UI.
    if not subscription.enabled:
        await LOGGER.ainfo("advance_next_delivery_date.skipped_disabled", subscription_id=subscription_id)
        return
    subscription.set_next_delivery_date(subscription.next_delivery_date)
    await database_sync_to_async(subscription.save, thread_sensitive=False)(update_fields=["next_delivery_date"])
    await LOGGER.ainfo(
        "advance_next_delivery_date.updated",
        subscription_id=subscription_id,
        next_delivery_date=subscription.next_delivery_date,
    )
