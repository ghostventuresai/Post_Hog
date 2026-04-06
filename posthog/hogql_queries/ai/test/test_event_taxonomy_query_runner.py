from datetime import timedelta

from freezegun import freeze_time
from posthog.test.base import (
    APIBaseTest,
    ClickhouseTestMixin,
    _create_event,
    _create_person,
    flush_persons_and_events,
    snapshot_clickhouse_queries,
)

from django.test import override_settings
from django.utils import timezone

from posthog.schema import CachedEventTaxonomyQueryResponse, EventTaxonomyQuery

from posthog.hogql_queries.ai.event_taxonomy_query_runner import EventTaxonomyQueryRunner
from posthog.models import Action, PropertyDefinition

from products.event_definitions.backend.models.property_definition import PropertyType


@override_settings(IN_UNIT_TESTING=True)
class TestEventTaxonomyQueryRunner(ClickhouseTestMixin, APIBaseTest):
    @snapshot_clickhouse_queries
    def test_event_taxonomy_query_runner(self):
        _create_person(
            distinct_ids=["person1"],
            properties={"email": "person1@example.com"},
            team=self.team,
        )
        _create_event(
            event="event1",
            distinct_id="person1",
            properties={"$browser": "Chrome", "$country": "US"},
            team=self.team,
        )
        _create_event(
            event="event1",
            distinct_id="person1",
            properties={"$browser": "Safari", "$country": "UK"},
            team=self.team,
        )
        _create_event(
            event="event1",
            distinct_id="person1",
            properties={"$browser": "Firefox", "$country": "US"},
            team=self.team,
        )
        _create_event(
            event="event1",
            distinct_id="person1",
            properties={"$browser": "Mobile Safari", "$country": "UK"},
            team=self.team,
        )
        _create_event(
            event="event1",
            distinct_id="person1",
            properties={"$browser": "Netscape", "$country": "US"},
            team=self.team,
        )
        _create_event(
            event="event1",
            distinct_id="person1",
            properties={"$browser": "Mobile Chrome", "$country": "UK"},
            team=self.team,
        )

        response = EventTaxonomyQueryRunner(team=self.team, query=EventTaxonomyQuery(event="event1")).calculate()
        self.assertEqual(len(response.results), 2)
        self.assertEqual(response.results[0].property, "$browser")
        self.assertEqual(
            response.results[0].sample_values,
            [
                "Mobile Chrome",
                "Netscape",
                "Mobile Safari",
                "Firefox",
                "Safari",
            ],
        )
        self.assertEqual(response.results[0].sample_count, 6)
        self.assertEqual(response.results[1].property, "$country")
        self.assertEqual(response.results[1].sample_values, ["UK", "US"])
        self.assertEqual(response.results[1].sample_count, 2)

    def test_event_taxonomy_query_filters_by_event(self):
        _create_person(
            distinct_ids=["person1"],
            properties={"email": "person1@example.com"},
            team=self.team,
        )
        _create_event(
            event="event1",
            distinct_id="person1",
            properties={"$browser": "Chrome", "$country": "US"},
            team=self.team,
        )
        _create_event(
            event="event1",
            distinct_id="person1",
            properties={"$browser": "Chrome", "$country": "UK"},
            team=self.team,
        )
        _create_event(
            event="event2",
            distinct_id="person1",
            properties={"$browser": "Safari", "$country": "UK"},
            team=self.team,
        )

        response = EventTaxonomyQueryRunner(team=self.team, query=EventTaxonomyQuery(event="event1")).calculate()
        self.assertEqual(len(response.results), 2)
        self.assertEqual(response.results[0].property, "$country")
        self.assertEqual(response.results[0].sample_values, ["UK", "US"])
        self.assertEqual(response.results[0].sample_count, 2)
        self.assertEqual(response.results[1].property, "$browser")
        self.assertEqual(response.results[1].sample_values, ["Chrome"])
        self.assertEqual(response.results[1].sample_count, 1)

    def test_event_taxonomy_query_excludes_properties(self):
        _create_person(
            distinct_ids=["person1"],
            properties={"email": "person1@example.com"},
            team=self.team,
        )
        _create_event(
            event="event1",
            distinct_id="person1",
            properties={"$browser__name": "Chrome", "$country": "US"},
            team=self.team,
        )
        _create_event(
            event="event1",
            distinct_id="person1",
            properties={"$set": "data", "$set_once": "data"},
            team=self.team,
        )

        response = EventTaxonomyQueryRunner(team=self.team, query=EventTaxonomyQuery(event="event1")).calculate()
        self.assertEqual(len(response.results), 1)
        self.assertEqual(response.results[0].property, "$country")
        self.assertEqual(response.results[0].sample_values, ["US"])
        self.assertEqual(response.results[0].sample_count, 1)

    def test_event_taxonomy_includes_properties_from_multiple_persons(self):
        _create_person(
            distinct_ids=["person1"],
            properties={"email": "person1@example.com"},
            team=self.team,
        )
        _create_person(
            distinct_ids=["person2"],
            properties={"email": "person1@example.com"},
            team=self.team,
        )
        _create_event(
            event="event1",
            distinct_id="person1",
            properties={"$browser": "Chrome", "$country": "US"},
            team=self.team,
        )
        _create_event(
            event="event1",
            distinct_id="person2",
            properties={"$browser": "Chrome", "$screen": "1024x768"},
            team=self.team,
        )

        response = EventTaxonomyQueryRunner(team=self.team, query=EventTaxonomyQuery(event="event1")).calculate()
        results = sorted(response.results, key=lambda x: x.property)
        self.assertEqual(len(results), 3)
        self.assertEqual(results[0].property, "$browser")
        self.assertEqual(results[0].sample_values, ["Chrome"])
        self.assertEqual(results[0].sample_count, 1)
        self.assertEqual(results[1].property, "$country")
        self.assertEqual(results[1].sample_values, ["US"])
        self.assertEqual(results[1].sample_count, 1)
        self.assertEqual(results[2].property, "$screen")
        self.assertEqual(results[2].sample_values, ["1024x768"])
        self.assertEqual(results[2].sample_count, 1)

    def test_caching(self):
        now = timezone.now()

        with freeze_time(now):
            _create_person(
                distinct_ids=["person1"],
                properties={"email": "person1@example.com"},
                team=self.team,
            )
            _create_event(
                event="event1",
                distinct_id="person1",
                team=self.team,
            )

            runner = EventTaxonomyQueryRunner(team=self.team, query=EventTaxonomyQuery(event="event1"))
            response = runner.run()

            assert isinstance(response, CachedEventTaxonomyQueryResponse)
            self.assertEqual(len(response.results), 0)

            key = response.cache_key
            _create_event(
                event="event1",
                distinct_id="person1",
                properties={"$browser": "Chrome"},
                team=self.team,
            )
            flush_persons_and_events()

            runner = EventTaxonomyQueryRunner(team=self.team, query=EventTaxonomyQuery(event="event1"))
            response = runner.run()

            assert isinstance(response, CachedEventTaxonomyQueryResponse)
            self.assertEqual(response.cache_key, key)
            self.assertEqual(len(response.results), 0)

        with freeze_time(now + timedelta(minutes=59)):
            runner = EventTaxonomyQueryRunner(team=self.team, query=EventTaxonomyQuery(event="event1"))
            response = runner.run()

            assert isinstance(response, CachedEventTaxonomyQueryResponse)
            self.assertEqual(len(response.results), 0)

        with freeze_time(now + timedelta(minutes=61)):
            runner = EventTaxonomyQueryRunner(team=self.team, query=EventTaxonomyQuery(event="event1"))
            response = runner.run()

            assert isinstance(response, CachedEventTaxonomyQueryResponse)
            self.assertEqual(len(response.results), 1)

    def test_limit(self):
        _create_person(
            distinct_ids=["person1"],
            properties={"email": "person1@example.com"},
            team=self.team,
        )

        for i in range(100):
            _create_event(
                event="event1",
                distinct_id="person1",
                properties={
                    f"prop_{i + 10}": "value",
                    f"prop_{i + 100}": "value",
                    f"prop_{i + 1000}": "value",
                    f"prop_{i + 10000}": "value",
                    f"prop_{i + 100000}": "value",
                    f"prop_{i + 1000000}": "value",
                },
                team=self.team,
            )

        response = EventTaxonomyQueryRunner(team=self.team, query=EventTaxonomyQuery(event="event1")).calculate()
        self.assertEqual(len(response.results), 500)

    def test_property_taxonomy_returns_unique_values_for_specified_property(self):
        _create_person(
            distinct_ids=["person1"],
            properties={"email": "person1@example.com"},
            team=self.team,
        )
        _create_person(
            distinct_ids=["person2"],
            properties={"email": "person1@example.com"},
            team=self.team,
        )

        _create_event(
            event="event1",
            distinct_id="person1",
            properties={"$host": "us.posthog.com"},
            team=self.team,
        )

        for _ in range(10):
            _create_event(
                event="event1",
                distinct_id="person1",
                properties={"$host": "posthog.com"},
                team=self.team,
            )

        for _ in range(3):
            _create_event(
                event="event1",
                distinct_id="person2",
                properties={"$host": "eu.posthog.com"},
                team=self.team,
            )

        response = EventTaxonomyQueryRunner(
            team=self.team, query=EventTaxonomyQuery(event="event1", properties=["$host"])
        ).calculate()
        self.assertEqual(len(response.results), 1)
        self.assertEqual(response.results[0].property, "$host")
        self.assertEqual(response.results[0].sample_values, ["posthog.com", "eu.posthog.com", "us.posthog.com"])
        self.assertEqual(response.results[0].sample_count, 3)

    def test_property_taxonomy_filters_events_by_event_name(self):
        _create_person(
            distinct_ids=["person1"],
            properties={"email": "person1@example.com"},
            team=self.team,
        )
        _create_person(
            distinct_ids=["person2"],
            properties={"email": "person1@example.com"},
            team=self.team,
        )

        _create_event(
            event="event1",
            distinct_id="person1",
            properties={"$host": "us.posthog.com", "$browser": "Chrome"},
            team=self.team,
        )

        for _ in range(10):
            _create_event(
                event="event2",
                distinct_id="person1",
                properties={"$host": "posthog.com", "prop": 10},
                team=self.team,
            )

        for _ in range(3):
            _create_event(
                event="event1",
                distinct_id="person2",
                team=self.team,
            )

        response = EventTaxonomyQueryRunner(
            team=self.team, query=EventTaxonomyQuery(event="event1", properties=["$host"])
        ).calculate()
        self.assertEqual(len(response.results), 1)
        self.assertEqual(response.results[0].property, "$host")
        self.assertEqual(response.results[0].sample_values, ["us.posthog.com"])
        self.assertEqual(response.results[0].sample_count, 1)

    def test_property_taxonomy_handles_multiple_properties_in_query(self):
        _create_person(
            distinct_ids=["person1"],
            properties={"email": "person1@example.com"},
            team=self.team,
        )
        _create_person(
            distinct_ids=["person2"],
            properties={"email": "person1@example.com"},
            team=self.team,
        )

        _create_event(
            event="event1",
            distinct_id="person1",
            properties={"$host": "us.posthog.com", "$browser": "Chrome"},
            team=self.team,
        )

        for _ in range(5):
            _create_event(
                event="event1",
                distinct_id="person1",
                properties={"$host": "posthog.com", "prop": 10},
                team=self.team,
            )

        for _ in range(3):
            _create_event(
                event="event1",
                distinct_id="person2",
                team=self.team,
            )

        response = EventTaxonomyQueryRunner(
            team=self.team, query=EventTaxonomyQuery(event="event1", properties=["$host", "prop"])
        ).calculate()
        self.assertEqual(len(response.results), 2)
        self.assertEqual(response.results[0].property, "prop")
        self.assertEqual(response.results[0].sample_values, ["10"])
        self.assertEqual(response.results[0].sample_count, 1)
        self.assertEqual(response.results[1].property, "$host")
        self.assertEqual(response.results[1].sample_values, ["posthog.com", "us.posthog.com"])
        self.assertEqual(response.results[1].sample_count, 2)

    def test_property_taxonomy_includes_events_with_partial_property_matches(self):
        _create_person(
            distinct_ids=["person1"],
            properties={"email": "person1@example.com"},
            team=self.team,
        )
        _create_event(
            event="event1",
            distinct_id="person1",
            properties={"$host": "us.posthog.com"},
            team=self.team,
        )
        _create_event(
            event="event1",
            distinct_id="person2",
            properties={"prop": 10},
            team=self.team,
        )

        response = EventTaxonomyQueryRunner(
            team=self.team, query=EventTaxonomyQuery(event="event1", properties=["$host", "prop"])
        ).calculate()
        self.assertEqual(len(response.results), 2)
        self.assertEqual(response.results[0].property, "prop")
        self.assertEqual(response.results[0].sample_values, ["10"])
        self.assertEqual(response.results[0].sample_count, 1)
        self.assertEqual(response.results[1].property, "$host")
        self.assertEqual(response.results[1].sample_values, ["us.posthog.com"])
        self.assertEqual(response.results[1].sample_count, 1)

    def test_query_count(self):
        _create_person(
            distinct_ids=["person1"],
            properties={"email": "person1@example.com"},
            team=self.team,
        )
        _create_event(
            event="event1",
            distinct_id="person1",
            properties={"prop": "1"},
            team=self.team,
        )
        _create_event(
            event="event1",
            distinct_id="person2",
            properties={"prop": "2"},
            team=self.team,
        )
        _create_event(
            event="event1",
            distinct_id="person2",
            properties={"prop": "3"},
            team=self.team,
        )

        response = EventTaxonomyQueryRunner(
            team=self.team, query=EventTaxonomyQuery(event="event1", properties=["prop"], maxPropertyValues=1)
        ).calculate()
        self.assertEqual(len(response.results), 1)
        self.assertEqual(response.results[0].property, "prop")
        self.assertEqual(response.results[0].sample_count, 3)
        self.assertEqual(len(response.results[0].sample_values), 1)

    def test_feature_flags_properties_are_omitted(self):
        _create_person(
            distinct_ids=["person1"],
            properties={"email": "person1@example.com"},
            team=self.team,
        )
        _create_event(
            event="event1",
            distinct_id="person1",
            properties={"$feature/ai": "1"},
            team=self.team,
        )
        _create_event(
            event="event1",
            distinct_id="person2",
            properties={"prop": "2"},
            team=self.team,
        )
        _create_event(
            event="event1",
            distinct_id="person2",
            properties={"prop": "3", "$feature/dashboard": "0"},
            team=self.team,
        )

        response = EventTaxonomyQueryRunner(team=self.team, query=EventTaxonomyQuery(event="event1")).calculate()
        self.assertEqual(len(response.results), 1)
        self.assertEqual(response.results[0].property, "prop")
        self.assertEqual(response.results[0].sample_count, 2)

    def test_dynamic_property_patterns_are_omitted(self):
        _create_person(
            distinct_ids=["person1"],
            properties={"email": "person1@example.com"},
            team=self.team,
        )
        _create_event(
            event="event1",
            distinct_id="person1",
            properties={
                "$feature_enrollment/beta-flag": "true",
                "$feature_interaction/new-dashboard": "true",
                "$product_tour_dismissed/tour123": "true",
                "$product_tour_shown/tour123": "true",
                "$product_tour_completed/tour456": "true",
                "survey_dismissed/abc": "true",
                "survey_responded/abc": "true",
                "visible_prop": "value",
            },
            team=self.team,
        )

        response = EventTaxonomyQueryRunner(team=self.team, query=EventTaxonomyQuery(event="event1")).calculate()
        self.assertEqual(len(response.results), 1)
        self.assertEqual(response.results[0].property, "visible_prop")

    @snapshot_clickhouse_queries
    def test_retrieves_action_properties(self):
        action = Action.objects.create(
            team=self.team,
            name="action1",
            steps_json=[{"event": "$pageview"}],
        )
        _create_person(
            distinct_ids=["person1"],
            properties={"email": "person1@example.com"},
            team=self.team,
        )
        _create_event(
            event="$pageview",
            distinct_id="person1",
            properties={"ai": "true"},
            team=self.team,
        )
        _create_event(
            event="$pageview",
            distinct_id="person1",
            properties={"dashboard": "true"},
            team=self.team,
        )
        _create_event(
            event="event",
            distinct_id="person1",
            properties={"prop": "3", "$feature/dashboard": "0"},
            team=self.team,
        )

        response = EventTaxonomyQueryRunner(team=self.team, query=EventTaxonomyQuery(actionId=action.id)).calculate()
        self.assertEqual(len(response.results), 2)
        self.assertListEqual([item.property for item in response.results], ["ai", "dashboard"])

    @snapshot_clickhouse_queries
    def test_property_taxonomy_handles_numeric_property_values(self):
        _create_person(
            distinct_ids=["person1"],
            properties={"email": "person1@example.com"},
            team=self.team,
        )

        # Create numeric property definition
        PropertyDefinition.objects.create(
            project=self.team.project,
            team=self.team,
            name="zero_duration_recording_count_in_period",
            type=PropertyDefinition.Type.EVENT,
            property_type=PropertyType.Numeric,
        )

        # Numeric property value event
        _create_event(
            event="organization usage report",
            distinct_id="person1",
            properties={"organization_id": "org123", "zero_duration_recording_count_in_period": 0},
            team=self.team,
        )
        _create_event(
            event="organization usage report",
            distinct_id="person1",
            properties={"organization_id": "org456", "zero_duration_recording_count_in_period": 10},
            team=self.team,
        )
        _create_event(
            event="organization usage report",
            distinct_id="person1",
            properties={"organization_id": "org789", "zero_duration_recording_count_in_period": 100},
            team=self.team,
        )
        # Empty string value for numeric property event
        _create_event(
            event="organization usage report",
            distinct_id="person1",
            properties={"organization_id": "org000", "zero_duration_recording_count_in_period": ""},
            team=self.team,
        )
        # Missing numeric property event
        _create_event(
            event="organization usage report",
            distinct_id="person1",
            properties={"organization_id": "org999"},
            team=self.team,
        )

        response = EventTaxonomyQueryRunner(
            team=self.team,
            query=EventTaxonomyQuery(
                event="organization usage report", properties=["zero_duration_recording_count_in_period"]
            ),
        ).calculate()

        self.assertEqual(len(response.results), 1)
        self.assertEqual(response.results[0].property, "zero_duration_recording_count_in_period")
        self.assertEqual(response.results[0].sample_count, 3)
        self.assertIn("0", response.results[0].sample_values)
        self.assertIn("10", response.results[0].sample_values)
        self.assertIn("100", response.results[0].sample_values)
        self.assertNotIn('""', response.results[0].sample_values)

    def test_property_taxonomy_handles_empty_string_values(self):
        _create_person(
            distinct_ids=["person1"],
            properties={"email": "person1@example.com"},
            team=self.team,
        )

        # Empty string value for numeric property event
        _create_event(
            event="organization usage report",
            distinct_id="person1",
            properties={"organization_id": "org000", "zero_duration_recording_count_in_period": ""},
            team=self.team,
        )

        response = EventTaxonomyQueryRunner(
            team=self.team,
            query=EventTaxonomyQuery(
                event="organization usage report", properties=["zero_duration_recording_count_in_period"]
            ),
        ).calculate()

        self.assertEqual(len(response.results), 0)

    def test_ai_generation_excludes_large_properties_from_scan(self):
        _create_person(
            distinct_ids=["person1"],
            properties={"email": "person1@example.com"},
            team=self.team,
        )
        _create_event(
            event="$ai_generation",
            distinct_id="person1",
            properties={
                "$ai_input": '{"role": "user", "content": "very long prompt..."}',
                "$ai_output_choices": '[{"message": {"content": "very long response..."}}]',
                "$ai_model": "gpt-4",
                "$ai_input_tokens": "100",
            },
            team=self.team,
        )

        response = EventTaxonomyQueryRunner(
            team=self.team, query=EventTaxonomyQuery(event="$ai_generation")
        ).calculate()

        result_props = {item.property for item in response.results}
        # Large properties should appear in the listing but with empty sample values
        self.assertIn("$ai_input", result_props)
        self.assertIn("$ai_output_choices", result_props)
        # Regular properties should still have sample values
        self.assertIn("$ai_model", result_props)
        self.assertIn("$ai_input_tokens", result_props)

        for item in response.results:
            if item.property in ("$ai_input", "$ai_output_choices"):
                self.assertEqual(item.sample_values, [])
                self.assertEqual(item.sample_count, 0)
            elif item.property == "$ai_model":
                self.assertEqual(item.sample_values, ["gpt-4"])

    def test_ai_span_excludes_large_properties_from_scan(self):
        _create_person(
            distinct_ids=["person1"],
            properties={"email": "person1@example.com"},
            team=self.team,
        )
        _create_event(
            event="$ai_span",
            distinct_id="person1",
            properties={
                "$ai_input_state": '{"context": "very large state"}',
                "$ai_output_state": '{"result": "very large output"}',
                "$ai_span_name": "my-span",
            },
            team=self.team,
        )

        response = EventTaxonomyQueryRunner(team=self.team, query=EventTaxonomyQuery(event="$ai_span")).calculate()

        result_props = {item.property for item in response.results}
        self.assertIn("$ai_input_state", result_props)
        self.assertIn("$ai_output_state", result_props)
        self.assertIn("$ai_span_name", result_props)

        for item in response.results:
            if item.property in ("$ai_input_state", "$ai_output_state"):
                self.assertEqual(item.sample_values, [])
                self.assertEqual(item.sample_count, 0)
            elif item.property == "$ai_span_name":
                self.assertEqual(item.sample_values, ["my-span"])

    def test_ai_large_properties_excluded_from_specific_property_scan(self):
        _create_person(
            distinct_ids=["person1"],
            properties={"email": "person1@example.com"},
            team=self.team,
        )
        _create_event(
            event="$ai_generation",
            distinct_id="person1",
            properties={
                "$ai_input": '{"role": "user", "content": "test"}',
                "$ai_model": "gpt-4",
            },
            team=self.team,
        )

        # When explicitly requesting an excluded property alongside a normal one
        response = EventTaxonomyQueryRunner(
            team=self.team,
            query=EventTaxonomyQuery(event="$ai_generation", properties=["$ai_input", "$ai_model"]),
        ).calculate()

        result_props = {item.property for item in response.results}
        self.assertIn("$ai_model", result_props)
        self.assertIn("$ai_input", result_props)

        for item in response.results:
            if item.property == "$ai_input":
                self.assertEqual(item.sample_values, [])
                self.assertEqual(item.sample_count, 0)
            elif item.property == "$ai_model":
                self.assertEqual(item.sample_values, ["gpt-4"])

    def test_ai_large_properties_all_excluded_returns_empty_scan(self):
        # When all requested properties are excluded, the runner early-returns without querying
        response = EventTaxonomyQueryRunner(
            team=self.team,
            query=EventTaxonomyQuery(event="$ai_generation", properties=["$ai_input", "$ai_output_choices"]),
        ).calculate()

        result_props = {item.property for item in response.results}
        self.assertIn("$ai_input", result_props)
        self.assertIn("$ai_output_choices", result_props)
        for item in response.results:
            self.assertEqual(item.sample_values, [])
            self.assertEqual(item.sample_count, 0)

    def test_non_ai_events_not_affected_by_exclusion(self):
        _create_person(
            distinct_ids=["person1"],
            properties={"email": "person1@example.com"},
            team=self.team,
        )
        _create_event(
            event="custom_event",
            distinct_id="person1",
            properties={"$ai_input": "some_value"},
            team=self.team,
        )

        response = EventTaxonomyQueryRunner(team=self.team, query=EventTaxonomyQuery(event="custom_event")).calculate()

        # $ai_input should be scanned normally for non-AI events
        result_props = {item.property for item in response.results}
        self.assertIn("$ai_input", result_props)
        for item in response.results:
            if item.property == "$ai_input":
                self.assertEqual(item.sample_values, ["some_value"])
                self.assertEqual(item.sample_count, 1)
