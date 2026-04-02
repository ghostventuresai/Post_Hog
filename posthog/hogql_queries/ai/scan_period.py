from enum import StrEnum

from django.core.cache import cache

from posthog.models import Team

from products.event_definitions.backend.models.event_definition import EventDefinition
from products.event_definitions.backend.models.property_definition import PropertyDefinition

# Cardinality thresholds for the Postgres fallback. If a low-volume org
# exceeds these, we use ClickHouse instead so we get count-based ordering.
EVENT_CARDINALITY_THRESHOLD = 50
PROPERTY_CARDINALITY_THRESHOLD = 100

_CACHE_TTL_SECONDS = 60 * 60  # 1 hour
_CACHE_KEY_PREFIX = "taxonomy_volume_tier"


class TaxonomyVolumeTier(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    EXTRA_HIGH = "extra_high"


SCAN_PERIOD_DAYS: dict[TaxonomyVolumeTier, int] = {
    TaxonomyVolumeTier.LOW: 7,
    TaxonomyVolumeTier.MEDIUM: 30,
    TaxonomyVolumeTier.HIGH: 7,
    TaxonomyVolumeTier.EXTRA_HIGH: 3,
}


def _has_high_cardinality(team: Team) -> bool:
    event_count = EventDefinition.objects.filter(team=team).count()
    if event_count > EVENT_CARDINALITY_THRESHOLD:
        return True

    property_count = PropertyDefinition.objects.filter(team=team, type=PropertyDefinition.Type.EVENT).count()
    return property_count > PROPERTY_CARDINALITY_THRESHOLD


def _compute_volume_tier(team: Team) -> TaxonomyVolumeTier:
    usage = team.organization.usage
    if not usage or not usage.get("events"):
        return TaxonomyVolumeTier.MEDIUM

    event_usage = usage["events"].get("usage") or 0
    if event_usage < 100_000:
        if _has_high_cardinality(team):
            return TaxonomyVolumeTier.MEDIUM
        return TaxonomyVolumeTier.LOW
    elif event_usage <= 5_000_000:
        return TaxonomyVolumeTier.MEDIUM
    elif event_usage <= 50_000_000:
        return TaxonomyVolumeTier.HIGH
    return TaxonomyVolumeTier.EXTRA_HIGH


def get_taxonomy_volume_tier(team: Team) -> TaxonomyVolumeTier:
    """
    Determine the taxonomy volume tier for a team, cached in Redis for 1 hour.

    Gated behind the phai-dynamic-taxonomy-scan-period feature flag.
    When disabled, returns MEDIUM (30-day scan, current default behavior).
    """
    try:
        from ee.hogai.utils.feature_flags import is_dynamic_scan_period_enabled
    except ImportError:
        return TaxonomyVolumeTier.MEDIUM

    if not is_dynamic_scan_period_enabled(team):
        return TaxonomyVolumeTier.MEDIUM

    cache_key = f"{_CACHE_KEY_PREFIX}:{team.pk}"
    cached = cache.get(cache_key)
    if cached is not None:
        return TaxonomyVolumeTier(cached)

    tier = _compute_volume_tier(team)
    cache.set(cache_key, tier.value, timeout=_CACHE_TTL_SECONDS)
    return tier


def get_scan_period_days(team: Team) -> int:
    """Return the ClickHouse scan period in days for the team's volume tier."""
    return SCAN_PERIOD_DAYS[get_taxonomy_volume_tier(team)]


def should_use_postgres_for_events(team: Team) -> bool:
    """Whether to use Postgres EventDefinition instead of ClickHouse for event listing."""
    return get_taxonomy_volume_tier(team) == TaxonomyVolumeTier.LOW
