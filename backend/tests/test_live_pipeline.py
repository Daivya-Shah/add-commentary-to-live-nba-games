import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from live_game_data import (
    LiveGameEvent,
    LiveGamePackage,
    NBAApiGameDataProvider,
    LivePlayer,
    LiveTeam,
    StaticGameDataProvider,
    align_replay_time,
    game_elapsed_sec,
    resolve_nba_team,
    search_nba_games,
)
from live_kb import build_pregame_kb
from live_sessions import LiveSessionConfig, LiveSessionManager, _download_video_temp
from live_state import (
    FeedContext,
    LiveStateReconciler,
    VisualObservation,
    action_detail_from_text,
    context_team_name,
    feed_context_to_payload,
    generate_context_caption_text,
    live_chat_completion_kwargs,
    live_text_model,
    template_caption,
    template_context_caption,
)

os.environ["OPENAI_API_KEY"] = ""


class LivePipelineUnitTests(unittest.IsolatedAsyncioTestCase):
    def test_align_replay_time_from_start_clock(self):
        period, clock, elapsed = align_replay_time(1, "12:00", 75)
        self.assertEqual(period, 1)
        self.assertEqual(clock, "10:45")
        self.assertEqual(elapsed, 75)

    def test_overtime_alignment(self):
        period, clock, _ = align_replay_time(4, "0:10", 20)
        self.assertEqual(period, 5)
        self.assertEqual(clock, "4:50")

    def test_pregame_kb_player_lookup(self):
        package = LiveGamePackage(
            game_id="fixture",
            teams=[LiveTeam(team_id="1", name="Boston Celtics", abbreviation="BOS")],
            players=[
                LivePlayer(
                    player_id="7",
                    name="Jaylen Brown",
                    team_id="1",
                    team_name="Boston Celtics",
                    jersey="7",
                    position="G-F",
                )
            ],
        )
        kb = build_pregame_kb(package)
        facts = kb.facts_for("Jaylen Brown", "Boston Celtics", limit=3)
        self.assertTrue(any("jersey #7" in fact for fact in facts))

    def test_pregame_kb_can_skip_extra_player_team_facts(self):
        package = LiveGamePackage(
            game_id="fixture",
            teams=[LiveTeam(team_id="1", name="Boston Celtics", abbreviation="BOS")],
            players=[LivePlayer(player_id="7", name="Jaylen Brown", team_name="Boston Celtics", jersey="7")],
        )
        kb = build_pregame_kb(package, include_knowledge=False)

        self.assertEqual(kb.team_names, ["Boston Celtics"])
        self.assertEqual(kb.facts_for("Jaylen Brown", "Boston Celtics", limit=3), [])

    def test_live_text_model_defaults_to_gpt5_nano(self):
        with patch.dict(os.environ, {"OPENAI_TEXT_MODEL": "gpt-4o-mini"}, clear=True):
            self.assertEqual(live_text_model(), "gpt-5.4-nano")
            kwargs = live_chat_completion_kwargs(model=live_text_model(), max_tokens=80, temperature=0.45)
        self.assertEqual(kwargs["model"], "gpt-5.4-nano")
        self.assertEqual(kwargs["max_completion_tokens"], 80)
        self.assertNotIn("max_tokens", kwargs)
        self.assertNotIn("temperature", kwargs)

    def test_live_text_model_env_override(self):
        with patch.dict(os.environ, {"OPENAI_LIVE_TEXT_MODEL": "gpt-5-nano"}, clear=True):
            self.assertEqual(live_text_model(), "gpt-5-nano")

    def test_team_resolver_accepts_name_and_abbreviation(self):
        self.assertEqual(resolve_nba_team("WAS").abbreviation, "WAS")
        self.assertEqual(resolve_nba_team("Washington Wizards").abbreviation, "WAS")
        self.assertEqual(resolve_nba_team("Hornets").abbreviation, "CHA")

    def test_game_search_normalizes_league_game_finder_rows(self):
        import pandas as pd

        class Finder:
            def __init__(self, **kwargs):
                self.kwargs = kwargs

            def get_data_frames(self):
                return [
                    pd.DataFrame(
                        [
                            {
                                "GAME_ID": "0022300157",
                                "GAME_DATE": "2023-11-08",
                                "MATCHUP": "WAS @ CHA",
                                "TEAM_ABBREVIATION": "WAS",
                                "WL": "W",
                                "PTS": 132,
                                "PLUS_MINUS": 16,
                            }
                        ]
                    )
                ]

        with patch("nba_api.stats.endpoints.leaguegamefinder.LeagueGameFinder", Finder):
            results = search_nba_games(
                team="WAS",
                opponent="CHA",
                season="2023-24",
                season_type="Regular Season",
            )
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].game_id, "0022300157")
        self.assertEqual(results[0].home_team, "CHA")
        self.assertEqual(results[0].away_team, "WAS")
        self.assertEqual(results[0].score, "132-116")

    def test_nba_provider_skips_roster_load_when_knowledge_disabled(self):
        import pandas as pd

        class PlayByPlay:
            kwargs = {}

            def __init__(self, **kwargs):
                type(self).kwargs = kwargs

            def get_data_frames(self):
                return [
                    pd.DataFrame(
                        [
                            {
                                "description": "Test Player makes 2PT layup",
                                "period": 1,
                                "clock": "PT11M59.00S",
                                "teamId": 1610612764,
                                "teamTricode": "WAS",
                                "personId": 1,
                                "playerName": "Test Player",
                                "actionType": "made",
                                "subType": "layup",
                                "actionNumber": 1,
                                "scoreHome": "0",
                                "scoreAway": "2",
                            }
                        ]
                    )
                ]

        provider = NBAApiGameDataProvider()
        with patch("nba_api.stats.endpoints.playbyplayv3.PlayByPlayV3", PlayByPlay), patch(
            "nba_api.stats.static.teams.get_teams",
            return_value=[
                {
                    "id": 1610612764,
                    "full_name": "Washington Wizards",
                    "abbreviation": "WAS",
                    "city": "Washington",
                }
            ],
        ), patch.object(provider, "_load_rosters", side_effect=AssertionError("rosters should be skipped")):
            package = provider.load_game("0022300157", include_knowledge=False)

        self.assertEqual(len(package.events), 1)
        self.assertEqual(package.teams[0].name, "Washington Wizards")
        self.assertEqual(PlayByPlay.kwargs["timeout"], 6)

    async def test_download_video_temp_resolves_local_upload_without_http(self):
        upload_id = "a" * 32
        upload_dir = Path(tempfile.gettempdir()) / "vision2voice-live-uploads"
        upload_dir.mkdir(parents=True, exist_ok=True)
        upload_path = upload_dir / f"{upload_id}.mp4"
        upload_path.write_bytes(b"fake video")
        self.addCleanup(lambda: upload_path.exists() and upload_path.unlink())

        with patch("live_sessions.httpx.AsyncClient", side_effect=AssertionError("HTTP should not be used")):
            resolved = await _download_video_temp(f"http://127.0.0.1:8000/live/uploads/{upload_id}")

        self.assertEqual(resolved, str(upload_path))

    async def test_download_video_temp_missing_local_upload_errors(self):
        with self.assertRaisesRegex(RuntimeError, "Replay upload not found"):
            await _download_video_temp(f"http://127.0.0.1:8000/live/uploads/{'b' * 32}")

    async def test_reconciler_suppresses_duplicate_feed_events(self):
        kb = build_pregame_kb(LiveGamePackage(game_id="fixture"))
        reconciler = LiveStateReconciler(kb)
        event = LiveGameEvent(
            event_id="1",
            period=1,
            clock="11:30",
            game_elapsed_sec=30,
            event_type="made_shot",
            description="Player makes 3PT jump shot",
            player_name="Player",
            team_name="Team",
        )
        self.assertEqual(reconciler.unseen_feed_events([event]), [event])
        await reconciler.caption_for_feed_event(event, replay_time_sec=30, visual=None)
        self.assertEqual(reconciler.unseen_feed_events([event]), [])

    async def test_context_caption_uses_feed_context_source(self):
        package = LiveGamePackage(
            game_id="fixture",
            teams=[LiveTeam(team_id="1", name="Test Team", abbreviation="TST")],
            events=[
                LiveGameEvent(
                    event_id="prior",
                    period=1,
                    clock="11:45",
                    game_elapsed_sec=15,
                    event_type="made_shot",
                    description="Test Player makes 2PT layup",
                    player_name="Test Player",
                    team_name="Test Team",
                    score="2-0",
                ),
                LiveGameEvent(
                    event_id="next",
                    period=1,
                    clock="11:30",
                    game_elapsed_sec=30,
                    event_type="rebound",
                    description="Opponent REBOUND",
                    team_name="Opponent",
                ),
            ],
        )
        kb = build_pregame_kb(package)
        reconciler = LiveStateReconciler(kb)
        decision = await reconciler.caption_for_feed_context(
            period=1,
            clock="11:36",
            replay_time_sec=24,
            visual=VisualObservation("players space the floor around the arc", 0.6, changed=True),
            context=FeedContext(
                period=1,
                clock="11:36",
                team_names=["Test Team", "Opponent"],
                nearest_prior=package.events[0],
                nearest_next=package.events[1],
                last_score="2-0",
            ),
        )
        self.assertIsNotNone(decision)
        self.assertEqual(decision.source, "feed_context_with_vision")
        self.assertNotEqual(decision.source, "vision_only")
        self.assertEqual(decision.score, "2-0")
        self.assertEqual(decision.feed_context["nearest_prior_event"]["event_id"], "prior")
        self.assertNotIn("nearest_next_event", decision.feed_context)

    async def test_feed_event_template_includes_active_visual_gameplay(self):
        package = LiveGamePackage(
            game_id="fixture",
            teams=[LiveTeam(team_id="1", name="Test Team", abbreviation="TST")],
            events=[
                LiveGameEvent(
                    event_id="drive",
                    period=1,
                    clock="10:58",
                    game_elapsed_sec=62,
                    event_type="made_shot",
                    description="Test Player makes 2PT layup",
                    player_name="Test Player",
                    team_name="Test Team",
                    score="4-2",
                )
            ],
        )
        kb = build_pregame_kb(package)
        reconciler = LiveStateReconciler(kb)
        with patch.dict(os.environ, {"OPENAI_API_KEY": ""}):
            decision = await reconciler.caption_for_feed_event(
                package.events[0],
                replay_time_sec=62,
                visual=VisualObservation("the ball-handler attacks downhill as help defense collapses", 0.8, True, "high"),
            )
        self.assertEqual(decision.source, "feed_with_vision")
        self.assertIn("attacks downhill", decision.text)
        self.assertEqual(decision.score, "4-2")

    def test_feed_event_template_calls_out_driving_layup_detail(self):
        event = LiveGameEvent(
            event_id="drive",
            period=1,
            clock="10:58",
            game_elapsed_sec=62,
            event_type="made_shot",
            description="Test Player makes 2PT driving layup",
            player_name="Test Player",
            team_name="Test Team",
            score="4-2",
        )
        kb = build_pregame_kb(LiveGamePackage(game_id="fixture"))

        text = template_caption(event, kb, visual=None)

        self.assertIn("Test Player", text)
        self.assertIn("driving layup", text)
        self.assertIn("4-2", text)

    def test_action_detail_preserves_stepback_and_pullup_threes(self):
        self.assertEqual(
            action_detail_from_text("Stephen Curry 25' 3PT Step Back Jump Shot"),
            "step-back three",
        )
        self.assertEqual(
            action_detail_from_text("Klay Thompson makes 26-foot pullup 3PT jump shot"),
            "pull-up three",
        )

    def test_generic_feed_event_template_stays_concise_without_invented_moves(self):
        event = LiveGameEvent(
            event_id="generic",
            period=1,
            clock="9:40",
            game_elapsed_sec=140,
            event_type="game_event",
            description="Test Team gains possession",
            team_name="Test Team",
        )
        kb = build_pregame_kb(LiveGamePackage(game_id="fixture"))

        text = template_caption(event, kb, visual=None)

        self.assertLessEqual(len(text.split()), 28)
        self.assertNotIn("driving", text.lower())
        self.assertNotIn("step", text.lower())
        self.assertNotIn("pull-up", text.lower())

    def test_context_template_uses_visible_action_without_naming_player(self):
        context = FeedContext(
            period=1,
            clock="9:58",
            team_names=["Home Team", "Away Team"],
            last_score="10-8",
        )
        visual = VisualObservation(
            "the offense flows into screen action as the defense trails over the top",
            0.7,
            changed=True,
            action_level="medium",
        )

        text = template_context_caption(context, visual)

        self.assertIn("screen action", text)
        self.assertNotIn("Test Player", text)
        self.assertIn("10-8", text)

    async def test_low_action_context_caption_shifts_to_analysis(self):
        package = LiveGamePackage(
            game_id="fixture",
            teams=[
                LiveTeam(team_id="1", name="Test Team", abbreviation="TST"),
                LiveTeam(team_id="2", name="Opponent", abbreviation="OPP"),
            ],
            events=[
                LiveGameEvent(
                    event_id="prior",
                    period=2,
                    clock="8:20",
                    game_elapsed_sec=700,
                    event_type="rebound",
                    description="Test Team defensive rebound",
                    team_name="Test Team",
                    score="28-25",
                ),
                LiveGameEvent(
                    event_id="next",
                    period=2,
                    clock="8:06",
                    game_elapsed_sec=714,
                    event_type="turnover",
                    description="Opponent bad pass turnover",
                    team_name="Opponent",
                    score="28-25",
                ),
            ],
        )
        kb = build_pregame_kb(package)
        reconciler = LiveStateReconciler(kb)
        with patch.dict(os.environ, {"OPENAI_API_KEY": ""}):
            decision = await reconciler.caption_for_feed_context(
                period=2,
                clock="8:13",
                replay_time_sec=707,
                visual=VisualObservation("players are mostly stationary above the arc", 0.55, True, "low"),
                context=FeedContext(
                    period=2,
                    clock="8:13",
                    team_names=["Test Team", "Opponent"],
                    nearest_prior=package.events[0],
                    nearest_next=package.events[1],
                    last_score="28-25",
                ),
            )
        self.assertIsNotNone(decision)
        self.assertEqual(decision.source, "feed_context_with_vision")
        self.assertIn("current matchups", decision.text)
        self.assertNotIn("next action", decision.text.lower())
        self.assertNotIn("next pressure", decision.text.lower())
        self.assertIn("28-25", decision.text)

    def test_context_caption_payload_and_template_do_not_spoil_future_events(self):
        prior = LiveGameEvent(
            event_id="prior",
            period=1,
            clock="10:00",
            game_elapsed_sec=120,
            event_type="rebound",
            description="Home Team defensive rebound",
            team_name="Home Team",
            score="10-8",
        )
        future = LiveGameEvent(
            event_id="future",
            period=1,
            clock="9:52",
            game_elapsed_sec=128,
            event_type="made_shot",
            description="Away Team makes 3PT jump shot",
            player_name="Future Shooter",
            team_name="Away Team",
            score="11-10",
        )
        context = FeedContext(
            period=1,
            clock="9:58",
            team_names=["Home Team", "Away Team"],
            nearest_prior=prior,
            nearest_next=future,
            last_score="10-8",
        )
        payload = feed_context_to_payload(context)
        text = template_context_caption(
            context,
            VisualObservation("players settle into their half-court spacing", 0.5, True, "low"),
        )
        self.assertNotIn("nearest_next_event", payload)
        self.assertNotIn("next", text.lower())
        self.assertNotIn("Future Shooter", context.description())
        self.assertEqual(context_team_name(context), "Home Team")

    async def test_context_caption_no_api_fallback_reports_template_model(self):
        context = FeedContext(
            period=3,
            clock="5:40",
            team_names=["Test Team", "Opponent"],
            last_score="58-56",
        )
        with patch.dict(os.environ, {"OPENAI_API_KEY": ""}):
            text, model = await generate_context_caption_text(
                context=context,
                kb=build_pregame_kb(LiveGamePackage(game_id="fixture")),
                recent_captions=[],
                visual=VisualObservation("players walk into their half-court spots", 0.4, True, "low"),
            )
        self.assertEqual(model, "template-live-context")
        self.assertIn("spacing and tempo", text)
        self.assertIn("58-56", text)


class LivePipelineIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_youtube_feed_live_emits_new_feed_event_once_without_video_download(self):
        initial = LiveGamePackage(
            game_id="fixture",
            teams=[LiveTeam(team_id="1", name="Test Team", abbreviation="TST")],
            players=[LivePlayer(player_id="1", name="Test Player", team_id="1", team_name="Test Team")],
            events=[],
        )
        event = LiveGameEvent(
            event_id="evt-1",
            period=1,
            clock="11:59",
            game_elapsed_sec=game_elapsed_sec(1, "11:59"),
            event_type="made_shot",
            description="Test Player makes 2PT layup",
            player_name="Test Player",
            team_name="Test Team",
            score="2-0",
        )
        updated = LiveGamePackage(
            game_id="fixture",
            teams=initial.teams,
            players=initial.players,
            events=[event],
        )

        class SequenceProvider:
            def __init__(self):
                self.packages = [initial, updated, updated, updated]
                self.calls = 0

            def load_game(self, game_id: str) -> LiveGamePackage:
                package = self.packages[min(self.calls, len(self.packages) - 1)]
                self.calls += 1
                return package

        emitted: list[dict] = []

        async def sink(session_id: str, payload: dict) -> None:
            emitted.append(payload)

        manager = LiveSessionManager(provider=SequenceProvider(), event_sink=sink)
        manager._visual_observation = AsyncMock(return_value=None)  # type: ignore[method-assign]
        with patch.dict(os.environ, {"OPENAI_API_KEY": ""}), patch(
            "live_sessions._download_video_temp",
            AsyncMock(),
        ) as download, patch("live_sessions._video_duration_sec") as duration:
            session = await manager.create_session(
                LiveSessionConfig(
                    file_url=None,
                    nba_game_id="fixture",
                    start_period=1,
                    start_clock="12:00",
                    cadence_sec=0.03,
                    clock_mode="feed_live",
                    source_type="youtube_embed",
                    youtube_video_id="dQw4w9WgXcQ",
                )
            )
            await asyncio.sleep(0.14)
            await manager.stop_session(session.session_id)
            await asyncio.sleep(0.04)

        captions = [event for event in emitted if event.get("type") == "caption"]
        self.assertEqual(len(captions), 1)
        self.assertEqual(captions[0]["source"], "feed")
        self.assertEqual(captions[0]["event_id"], "evt-1")
        download.assert_not_awaited()
        duration.assert_not_called()
        manager._visual_observation.assert_not_awaited()

    async def test_feed_live_first_caption_does_not_wait_for_enrichment(self):
        event = LiveGameEvent(
            event_id="evt-slow",
            period=1,
            clock="11:59",
            game_elapsed_sec=game_elapsed_sec(1, "11:59"),
            event_type="made_shot",
            description="Test Player makes 2PT layup",
            player_name="Test Player",
            team_name="Test Team",
            score="2-0",
        )

        class SequenceProvider:
            def __init__(self):
                self.calls = 0

            def load_game(self, game_id: str) -> LiveGamePackage:
                self.calls += 1
                return LiveGamePackage(game_id="fixture", events=[] if self.calls == 1 else [event])

        emitted: list[dict] = []

        async def sink(session_id: str, payload: dict) -> None:
            emitted.append(payload)

        async def slow_generate(*args, **kwargs):
            await asyncio.sleep(0.25)
            return "Slow enriched caption.", "mock-model"

        manager = LiveSessionManager(provider=SequenceProvider(), event_sink=sink)
        with patch.dict(os.environ, {"OPENAI_API_KEY": "test"}), patch(
            "live_state.generate_caption_text",
            AsyncMock(side_effect=slow_generate),
        ):
            session = await manager.create_session(
                LiveSessionConfig(
                    nba_game_id="fixture",
                    start_period=1,
                    start_clock="12:00",
                    cadence_sec=0.03,
                    clock_mode="feed_live",
                    source_type="youtube_embed",
                    youtube_video_id="dQw4w9WgXcQ",
                )
            )
            await asyncio.sleep(0.08)
            captions = [event for event in emitted if event.get("type") == "caption"]
            self.assertEqual(len(captions), 1)
            self.assertEqual(captions[0]["event_id"], "evt-slow")
            self.assertEqual(captions[0]["caption_stage"], "initial")
            self.assertEqual(captions[0]["model_name"], "template-live")
            await manager.stop_session(session.session_id)
            await asyncio.sleep(0.02)

    async def test_feed_live_enrichment_emits_caption_update(self):
        event = LiveGameEvent(
            event_id="evt-update",
            period=1,
            clock="11:59",
            game_elapsed_sec=game_elapsed_sec(1, "11:59"),
            event_type="made_shot",
            description="Test Player makes 2PT layup",
            player_name="Test Player",
            team_name="Test Team",
            score="2-0",
        )

        class SequenceProvider:
            def __init__(self):
                self.calls = 0

            def load_game(self, game_id: str) -> LiveGamePackage:
                self.calls += 1
                return LiveGamePackage(game_id="fixture", events=[] if self.calls == 1 else [event])

        emitted: list[dict] = []

        async def sink(session_id: str, payload: dict) -> None:
            emitted.append(payload)

        manager = LiveSessionManager(provider=SequenceProvider(), event_sink=sink)
        with patch.dict(os.environ, {"OPENAI_API_KEY": "test"}), patch(
            "live_state.generate_caption_text",
            AsyncMock(return_value=("Enriched caption with better rhythm.", "mock-model")),
        ):
            session = await manager.create_session(
                LiveSessionConfig(
                    nba_game_id="fixture",
                    start_period=1,
                    start_clock="12:00",
                    cadence_sec=0.03,
                    clock_mode="feed_live",
                    source_type="youtube_embed",
                    youtube_video_id="dQw4w9WgXcQ",
                )
            )
            for _ in range(20):
                if any(event.get("type") == "caption_update" for event in emitted):
                    break
                await asyncio.sleep(0.02)
            await manager.stop_session(session.session_id)
            await asyncio.sleep(0.02)

        updates = [event for event in emitted if event.get("type") == "caption_update"]
        self.assertEqual(len(updates), 1)
        self.assertEqual(updates[0]["event_id"], "evt-update")
        self.assertEqual(updates[0]["enriched_from_event_id"], "evt-update")
        self.assertEqual(updates[0]["caption_stage"], "enriched")
        self.assertEqual(updates[0]["text"], "Enriched caption with better rhythm.")

    async def test_feed_live_demo_event_emits_visible_caption_when_enabled(self):
        package = LiveGamePackage(
            game_id="fixture",
            teams=[LiveTeam(team_id="1", name="Test Team", abbreviation="TST")],
            events=[],
        )
        emitted: list[dict] = []

        async def sink(session_id: str, payload: dict) -> None:
            emitted.append(payload)

        manager = LiveSessionManager(provider=StaticGameDataProvider(package), event_sink=sink)
        with patch.dict(os.environ, {"OPENAI_API_KEY": "", "LIVE_FEED_DEMO_ENABLED": "1"}):
            session = await manager.create_session(
                LiveSessionConfig(
                    file_url=None,
                    nba_game_id="fixture",
                    start_period=1,
                    start_clock="12:00",
                    cadence_sec=0.03,
                    clock_mode="feed_live",
                    source_type="youtube_embed",
                    youtube_video_id="dQw4w9WgXcQ",
                    demo_feed_events=True,
                )
            )
            await asyncio.sleep(0.08)
            await manager.stop_session(session.session_id)
            await asyncio.sleep(0.04)

        captions = [event for event in emitted if event.get("type") == "caption"]
        self.assertEqual(len(captions), 1)
        self.assertEqual(captions[0]["source"], "feed")
        self.assertIn("demo feed event", captions[0]["feed_description"])

    async def test_session_stream_emits_caption_with_latency_metadata(self):
        package = LiveGamePackage(
            game_id="fixture",
            teams=[LiveTeam(team_id="1", name="Test Team", abbreviation="TST")],
            players=[LivePlayer(player_id="1", name="Test Player", team_id="1", team_name="Test Team")],
            events=[
                LiveGameEvent(
                    event_id="evt-1",
                    period=1,
                    clock="11:59",
                    game_elapsed_sec=game_elapsed_sec(1, "11:59"),
                    event_type="made_shot",
                    description="Test Player makes 2PT layup",
                    player_name="Test Player",
                    team_name="Test Team",
                )
            ],
        )
        manager = LiveSessionManager(provider=StaticGameDataProvider(package))
        manager._visual_observation = AsyncMock(return_value=None)  # type: ignore[method-assign]
        fd, temp_video = tempfile.mkstemp(suffix=".mp4")
        os.close(fd)

        with patch("live_sessions._download_video_temp", AsyncMock(return_value=temp_video)), patch(
            "live_sessions._video_duration_sec",
            return_value=1.0,
        ):
            session = await manager.create_session(
                LiveSessionConfig(
                    file_url="https://example.test/video.mp4",
                    nba_game_id="fixture",
                    start_period=1,
                    start_clock="12:00",
                    cadence_sec=1,
                    window_sec=2,
                    replay_speed=8,
                )
            )
            stream = manager.event_stream(session.session_id)
            await anext(stream)
            await manager.control_playback(
                session.session_id,
                state="playing",
                replay_time_sec=0,
                playback_rate=8,
            )
            seen_caption = None
            async for raw in stream:
                if '"type": "caption"' in raw:
                    seen_caption = raw
                    break
                if '"type": "complete"' in raw:
                    break
            self.assertIsNotNone(seen_caption)
            self.assertIn('"latency_ms"', seen_caption)
            self.assertIn('"source": "feed"', seen_caption)
            await stream.aclose()
            await asyncio.sleep(0)

    async def test_session_waits_for_playback_before_emitting_captions(self):
        package = LiveGamePackage(
            game_id="fixture",
            events=[
                LiveGameEvent(
                    event_id="evt-1",
                    period=1,
                    clock="11:59",
                    game_elapsed_sec=game_elapsed_sec(1, "11:59"),
                    event_type="made_shot",
                    description="Test Player makes 2PT layup",
                    player_name="Test Player",
                    team_name="Test Team",
                )
            ],
        )
        manager = LiveSessionManager(provider=StaticGameDataProvider(package))
        manager._visual_observation = AsyncMock(return_value=None)  # type: ignore[method-assign]
        fd, temp_video = tempfile.mkstemp(suffix=".mp4")
        os.close(fd)

        with patch("live_sessions._download_video_temp", AsyncMock(return_value=temp_video)), patch(
            "live_sessions._video_duration_sec",
            return_value=5.0,
        ):
            session = await manager.create_session(
                LiveSessionConfig(
                    file_url="https://example.test/video.mp4",
                    nba_game_id="fixture",
                    start_period=1,
                    start_clock="12:00",
                    cadence_sec=0.05,
                    window_sec=2,
                    replay_speed=8,
                )
            )
            await asyncio.sleep(0.15)
            self.assertEqual(session.status, "ready")
            self.assertEqual(session.replay_elapsed, 0)
            manager._visual_observation.assert_not_awaited()
            await manager.stop_session(session.session_id)

    async def test_pause_prevents_replay_clock_from_advancing(self):
        package = LiveGamePackage(game_id="fixture")
        manager = LiveSessionManager(provider=StaticGameDataProvider(package))
        manager._visual_observation = AsyncMock(return_value=None)  # type: ignore[method-assign]
        fd, temp_video = tempfile.mkstemp(suffix=".mp4")
        os.close(fd)

        with patch("live_sessions._download_video_temp", AsyncMock(return_value=temp_video)), patch(
            "live_sessions._video_duration_sec",
            return_value=5.0,
        ):
            session = await manager.create_session(
                LiveSessionConfig(
                    file_url="https://example.test/video.mp4",
                    nba_game_id="fixture",
                    start_period=1,
                    start_clock="12:00",
                    cadence_sec=0.05,
                    window_sec=2,
                    replay_speed=8,
                )
            )
            await manager.control_playback(
                session.session_id,
                state="playing",
                replay_time_sec=0,
                playback_rate=8,
            )
            await asyncio.sleep(0.1)
            self.assertGreater(session.replay_elapsed, 0)
            await manager.control_playback(
                session.session_id,
                state="paused",
                replay_time_sec=session.replay_elapsed,
                playback_rate=8,
            )
            paused_at = session.replay_elapsed
            await asyncio.sleep(0.15)
            self.assertEqual(session.status, "paused")
            self.assertEqual(session.replay_elapsed, paused_at)
            await manager.stop_session(session.session_id)

    async def test_seek_control_emits_tick_for_supplied_replay_time(self):
        package = LiveGamePackage(game_id="fixture")
        manager = LiveSessionManager(provider=StaticGameDataProvider(package))
        fd, temp_video = tempfile.mkstemp(suffix=".mp4")
        os.close(fd)

        with patch("live_sessions._download_video_temp", AsyncMock(return_value=temp_video)), patch(
            "live_sessions._video_duration_sec",
            return_value=20.0,
        ):
            session = await manager.create_session(
                LiveSessionConfig(
                    file_url="https://example.test/video.mp4",
                    nba_game_id="fixture",
                    start_period=1,
                    start_clock="12:00",
                    cadence_sec=1,
                    window_sec=2,
                    replay_speed=8,
                )
            )
            stream = manager.event_stream(session.session_id)
            await anext(stream)
            await manager.control_playback(
                session.session_id,
                state="paused",
                replay_time_sec=7,
                playback_rate=1,
            )
            seen_tick = None
            async for raw in stream:
                if '"type": "tick"' in raw and '"replay_time_sec": 7' in raw:
                    seen_tick = raw
                    break
            self.assertIsNotNone(seen_tick)
            self.assertEqual(session.replay_elapsed, 7)
            await stream.aclose()
            await manager.stop_session(session.session_id)

    async def test_session_stream_emits_feed_context_when_no_exact_event_matches(self):
        package = LiveGamePackage(
            game_id="fixture",
            teams=[
                LiveTeam(team_id="1", name="Test Team", abbreviation="TST"),
                LiveTeam(team_id="2", name="Opponent", abbreviation="OPP"),
            ],
            events=[
                LiveGameEvent(
                    event_id="prior",
                    period=1,
                    clock="11:50",
                    game_elapsed_sec=10,
                    event_type="made_shot",
                    description="Test Player makes 2PT layup",
                    player_name="Test Player",
                    team_name="Test Team",
                    score="2-0",
                ),
                LiveGameEvent(
                    event_id="next",
                    period=1,
                    clock="11:20",
                    game_elapsed_sec=40,
                    event_type="turnover",
                    description="Opponent bad pass turnover",
                    team_name="Opponent",
                ),
            ],
        )
        manager = LiveSessionManager(provider=StaticGameDataProvider(package))
        manager._visual_observation = AsyncMock(
            return_value=VisualObservation("players move through a half-court set", 0.6, changed=True)
        )  # type: ignore[method-assign]
        fd, temp_video = tempfile.mkstemp(suffix=".mp4")
        os.close(fd)

        with patch("live_sessions._download_video_temp", AsyncMock(return_value=temp_video)), patch(
            "live_sessions._video_duration_sec",
            return_value=20.0,
        ):
            session = await manager.create_session(
                LiveSessionConfig(
                    file_url="https://example.test/video.mp4",
                    nba_game_id="fixture",
                    start_period=1,
                    start_clock="11:45",
                    cadence_sec=1,
                    window_sec=2,
                    replay_speed=8,
                )
            )
            stream = manager.event_stream(session.session_id)
            await anext(stream)
            await manager.control_playback(
                session.session_id,
                state="playing",
                replay_time_sec=0,
                playback_rate=8,
            )
            seen_caption = None
            async for raw in stream:
                if '"type": "caption"' in raw:
                    seen_caption = raw
                    break
                if '"type": "complete"' in raw:
                    break
            self.assertIsNotNone(seen_caption)
            self.assertIn('"source": "feed_context_with_vision"', seen_caption)
            self.assertIn('"feed_context"', seen_caption)
            self.assertNotIn("nearest_next_event", seen_caption)
            self.assertNotIn("bad pass turnover", seen_caption)
            self.assertNotIn('"source": "vision_only"', seen_caption)
            await stream.aclose()


if __name__ == "__main__":
    unittest.main()
