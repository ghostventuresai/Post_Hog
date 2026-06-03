from typing import ClassVar

from unittest.mock import patch

from django.test import TestCase

from parameterized import parameterized

from posthog.models.integration import Integration
from posthog.models.organization import Organization
from posthog.models.team.team import Team
from posthog.models.user import User

from products.slack_app.backend.models import SlackThreadTaskMapping
from products.tasks.backend.models import Task, TaskRun
from products.tasks.backend.temporal.slack_relay.activities import (
    RelaySlackMessageInput,
    _markdown_to_slack_mrkdwn,
    relay_slack_message,
)


class TestRelaySlackMessage(TestCase):
    org: ClassVar[Organization]
    team: ClassVar[Team]
    user: ClassVar[User]
    integration: ClassVar[Integration]
    task: ClassVar[Task]
    task_run: ClassVar[TaskRun]

    @classmethod
    def setUpTestData(cls):
        cls.org = Organization.objects.create(name="TestOrg")
        cls.team = Team.objects.create(organization=cls.org, name="TestTeam")
        cls.user = User.objects.create(email="alice@test.com")

        cls.task = Task.objects.create(
            team=cls.team,
            title="Test task",
            description="desc",
            origin_product=Task.OriginProduct.SLACK,
            created_by=cls.user,
            repository="org/repo",
        )
        cls.task_run = TaskRun.objects.create(
            task=cls.task,
            team=cls.team,
            status=TaskRun.Status.IN_PROGRESS,
            state={},
        )
        cls.integration = Integration.objects.create(
            team=cls.team,
            kind="slack",
            integration_id="T123",
            config={},
        )
        SlackThreadTaskMapping.objects.create(
            team=cls.team,
            integration=cls.integration,
            slack_workspace_id="T123",
            channel="C123",
            thread_ts="1111.1",
            task=cls.task,
            task_run=cls.task_run,
            mentioning_slack_user_id="U123",
        )

    @parameterized.expand(
        [
            ("no_reaction_emoji", "relay-1", "Which license should I use?", None),
            ("explicit_reaction_emoji", "relay-2", "Could not deliver follow-up", "x"),
        ]
    )
    @patch("products.slack_app.backend.slack_thread.SlackThreadHandler.update_reaction")
    @patch("products.slack_app.backend.slack_thread.SlackThreadHandler.post_thread_message")
    @patch("products.slack_app.backend.slack_thread.SlackThreadHandler.delete_progress")
    def test_relay_posts_message_and_marks_sent(
        self,
        _name,
        relay_id,
        text,
        reaction_emoji,
        mock_delete_progress,
        mock_post,
        mock_update,
    ):
        relay_slack_message(
            RelaySlackMessageInput(
                run_id=str(self.task_run.id),
                relay_id=relay_id,
                text=text,
                user_message_ts="1234.5",
                reaction_emoji=reaction_emoji,
            )
        )

        mock_delete_progress.assert_called_once()
        mock_post.assert_called_once()
        assert text in mock_post.call_args.args[0]
        if reaction_emoji is None:
            mock_update.assert_not_called()
        else:
            mock_update.assert_called_once_with(reaction_emoji)
        self.task_run.refresh_from_db()
        assert relay_id in self.task_run.state.get("slack_sent_relay_ids", [])

    @parameterized.expand(
        [
            # The mapping's ``mentioning_slack_user_id`` is the original task
            # author. State carries the latest actor, set by the followup
            # handler. The bot's reply should tag whoever spoke most recently —
            # so it pings the original when no actor is recorded, and the
            # follow-up sender once one is.
            ("no_actor_falls_back_to_mentioner", {}, "<@U123> "),
            ("actor_overrides_mentioner", {"acting_slack_user_id": "UBOB"}, "<@UBOB> "),
        ]
    )
    @patch("products.slack_app.backend.slack_thread.SlackThreadHandler.update_reaction")
    @patch("products.slack_app.backend.slack_thread.SlackThreadHandler.post_thread_message")
    @patch("products.slack_app.backend.slack_thread.SlackThreadHandler.delete_progress")
    def test_mention_prefix_uses_acting_user_from_state(
        self,
        _name,
        state_overrides,
        expected_prefix,
        _mock_delete_progress,
        mock_post,
        _mock_update,
    ):
        TaskRun.update_state_atomic(str(self.task_run.id), updates=state_overrides)

        relay_slack_message(
            RelaySlackMessageInput(
                run_id=str(self.task_run.id),
                relay_id=f"relay-mention-{_name}",
                text="agent reply",
            )
        )

        mock_post.assert_called_once()
        assert mock_post.call_args.args[0].startswith(expected_prefix)


class TestMarkdownToSlackMrkdwn(TestCase):
    @parameterized.expand(
        [
            ("bold", "**hello**", "*hello*"),
            ("nested_bold_in_list", "- **MIT** is permissive", "- *MIT* is permissive"),
            ("strikethrough", "~~removed~~", "~removed~"),
            ("link", "[Click here](https://example.com)", "<https://example.com|Click here>"),
            ("image", "![alt](https://img.png)", "<https://img.png|alt>"),
            ("h1", "# Title", "*Title*"),
            ("h3", "### Section", "*Section*"),
            ("inline_code_preserved", "Use `git commit`", "Use `git commit`"),
            ("bold_not_in_code", "**bold** and `**not bold**`", "*bold* and `**not bold**`"),
            ("plain_text_unchanged", "Hello world", "Hello world"),
        ]
    )
    def test_inline_conversions(self, _name, markdown, expected):
        assert _markdown_to_slack_mrkdwn(markdown) == expected

    def test_table_converted_to_columns(self):
        md = "| License | Key Points |\n|---|---|\n| **MIT** | Permissive |\n| **GPL** | Copyleft |"
        result = _markdown_to_slack_mrkdwn(md)
        assert "---" not in result
        assert "*MIT*" in result
        assert "*GPL*" in result
        assert "Permissive" in result
        lines = [line for line in result.split("\n") if line.strip()]
        assert len(lines) == 3  # header + 2 data rows

    def test_code_block_preserved(self):
        md = "```python\n**not bold**\n```\nBut **this is bold**"
        result = _markdown_to_slack_mrkdwn(md)
        assert "```python\n**not bold**\n```" in result
        assert "*this is bold*" in result
