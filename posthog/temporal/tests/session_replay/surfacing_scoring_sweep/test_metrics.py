from unittest.mock import MagicMock, patch

from parameterized import parameterized

from posthog.temporal.session_replay.surfacing_scoring_sweep.metrics import (
    CHUNKS_FAILED_COUNTER,
    CHUNKS_FAILED_DESCRIPTION,
    TOTAL_SCORED_COUNTER,
    TOTAL_SCORED_DESCRIPTION,
    record_tick_summary,
)


class TestRecordTickSummary:
    @parameterized.expand(
        [
            ("scored", 42, 0, TOTAL_SCORED_COUNTER, TOTAL_SCORED_DESCRIPTION, 42),
            ("failed", 0, 3, CHUNKS_FAILED_COUNTER, CHUNKS_FAILED_DESCRIPTION, 3),
        ]
    )
    def test_emits_counter(
        self,
        _name: str,
        total_scored: int,
        chunks_failed: int,
        counter_name: str,
        counter_description: str,
        expected_count: int,
    ) -> None:
        mock_meter = MagicMock()
        mock_counter = MagicMock()
        mock_meter.create_counter.return_value = mock_counter

        with patch(
            "posthog.temporal.session_replay.surfacing_scoring_sweep.metrics.get_metric_meter",
            return_value=mock_meter,
        ):
            record_tick_summary(total_scored=total_scored, chunks_failed=chunks_failed)

        mock_meter.create_counter.assert_called_once_with(counter_name, counter_description)
        mock_counter.add.assert_called_once_with(expected_count)

    def test_emits_both_counters(self) -> None:
        mock_meter = MagicMock()
        with patch(
            "posthog.temporal.session_replay.surfacing_scoring_sweep.metrics.get_metric_meter",
            return_value=mock_meter,
        ):
            record_tick_summary(total_scored=10, chunks_failed=2)

        names = [call.args[0] for call in mock_meter.create_counter.call_args_list]
        assert names == [TOTAL_SCORED_COUNTER, CHUNKS_FAILED_COUNTER]

    @parameterized.expand(
        [
            ("both_zero", 0, 0),
            ("negative_scored", -1, 0),
            ("negative_failed", 0, -1),
        ]
    )
    def test_noops_for_non_positive_counts(self, _name: str, total_scored: int, chunks_failed: int) -> None:
        with patch(
            "posthog.temporal.session_replay.surfacing_scoring_sweep.metrics.get_metric_meter",
        ) as mock_get_meter:
            record_tick_summary(total_scored=total_scored, chunks_failed=chunks_failed)
            mock_get_meter.assert_not_called()
