import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

import main
from live_game_data import LiveGameSearchResult


class LiveApiTests(unittest.TestCase):
    def test_live_upload_accepts_raw_video_body(self):
        client = TestClient(main.app)
        response = client.post(
            "/live/uploads?filename=test.mp4",
            content=b"fake mp4 bytes",
            headers={"Content-Type": "video/mp4"},
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["filename"], "test.mp4")
        self.assertEqual(payload["size_bytes"], len(b"fake mp4 bytes"))
        self.assertIn("/live/uploads/", payload["file_url"])

        video = client.get(payload["file_url"])
        self.assertEqual(video.status_code, 200)
        self.assertEqual(video.content, b"fake mp4 bytes")

    def test_clips_upload_returns_503_when_supabase_not_configured(self):
        client = TestClient(main.app)
        with patch.dict("os.environ", {"SUPABASE_URL": "", "SUPABASE_SERVICE_ROLE_KEY": ""}):
            response = client.post(
                "/clips/upload?filename=x.mp4",
                content=b"fake-bytes",
                headers={"Content-Type": "video/mp4"},
            )
        self.assertEqual(response.status_code, 503)

    def test_clips_upload_proxies_to_supabase_storage_and_rest(self):
        class FakeResp:
            def __init__(self, status_code: int, json_body=None):
                self.status_code = status_code
                self.text = ""
                self._json = json_body

            def json(self):
                return self._json

        class FakeClient:
            def __init__(self, *a, **k):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                return None

            async def post(self, url: str, **kwargs):
                if "/storage/v1/object/videos/" in url:
                    return FakeResp(200)
                if "/rest/v1/clips" in url:
                    return FakeResp(201, [{"id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc"}])
                raise AssertionError(f"unexpected url {url!r}")

        client = TestClient(main.app)
        env = {
            "SUPABASE_URL": "https://ex.supabase.co",
            "SUPABASE_SERVICE_ROLE_KEY": "sk-test",
        }
        with patch.dict("os.environ", env):
            with patch.object(main.httpx, "AsyncClient", return_value=FakeClient()):
                response = client.post(
                    "/clips/upload?filename=x.mp4",
                    content=b"fake-bytes",
                    headers={"Content-Type": "video/mp4"},
                )
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["clip_id"], "cccccccc-cccc-4ccc-8ccc-cccccccccccc")
        self.assertTrue(body["file_url"].startswith("https://ex.supabase.co/storage/v1/object/public/videos/"))

    def test_live_playback_control_forwards_media_clock(self):
        client = TestClient(main.app)
        with patch.object(main.live_sessions, "control_playback", AsyncMock(return_value=True)) as control:
            response = client.post(
                "/live/sessions/session-1/playback",
                json={"state": "paused", "replay_time_sec": 12.5, "playback_rate": 1.25},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "paused"})
        control.assert_awaited_once_with(
            "session-1",
            state="paused",
            replay_time_sec=12.5,
            playback_rate=1.25,
            duration_sec=None,
        )

    def test_stop_unknown_live_session_is_idempotent(self):
        client = TestClient(main.app)
        with patch.object(main.live_sessions, "stop_session", AsyncMock(return_value=False)) as stop:
            response = client.post("/live/sessions/missing/stop")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "stopped"})
        stop.assert_awaited_once_with("missing")

    def test_youtube_live_session_does_not_require_file_url(self):
        client = TestClient(main.app)
        fake_session = SimpleNamespace(
            session_id="session-yt",
            status="running",
            config=SimpleNamespace(source_type="youtube_embed"),
            kb=SimpleNamespace(team_names=["WAS", "CHA"], warnings=[]),
            events=[],
        )
        with patch.object(main.live_sessions, "create_session", AsyncMock(return_value=fake_session)) as create:
            response = client.post(
                "/live/sessions",
                json={
                    "source_type": "youtube_embed",
                    "youtube_video_id": "dQw4w9WgXcQ",
                    "nba_game_id": "0022300157",
                    "start_period": 1,
                    "start_clock": "12:00",
                    "demo_feed_events": True,
                },
            )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["source_type"], "youtube_embed")
        config = create.await_args.args[0]
        self.assertIsNone(config.file_url)
        self.assertEqual(config.clock_mode, "feed_live")
        self.assertEqual(config.youtube_video_id, "dQw4w9WgXcQ")
        self.assertTrue(config.demo_feed_events)
        self.assertFalse(config.include_knowledge)

    def test_live_session_accepts_include_knowledge(self):
        client = TestClient(main.app)
        fake_session = SimpleNamespace(
            session_id="session-knowledge",
            status="ready",
            config=SimpleNamespace(source_type="replay_file"),
            kb=SimpleNamespace(team_names=["WAS", "CHA"], warnings=[]),
            events=[],
        )
        with patch.object(main.live_sessions, "create_session", AsyncMock(return_value=fake_session)) as create:
            response = client.post(
                "/live/sessions",
                json={
                    "source_type": "replay_file",
                    "file_url": "https://example.test/replay.mp4",
                    "nba_game_id": "0022300157",
                    "start_period": 1,
                    "start_clock": "12:00",
                    "include_knowledge": True,
                },
            )
        self.assertEqual(response.status_code, 200)
        config = create.await_args.args[0]
        self.assertTrue(config.include_knowledge)

    def test_replay_session_can_omit_manual_start_clock(self):
        client = TestClient(main.app)
        fake_session = SimpleNamespace(
            session_id="session-auto-clock",
            status="ready",
            config=SimpleNamespace(source_type="replay_file"),
            kb=SimpleNamespace(team_names=["WAS", "CHA"], warnings=[]),
            events=[],
        )
        with patch.object(main.live_sessions, "create_session", AsyncMock(return_value=fake_session)) as create:
            response = client.post(
                "/live/sessions",
                json={
                    "source_type": "replay_file",
                    "file_url": "https://example.test/replay.mp4",
                    "nba_game_id": "0022300157",
                },
            )
        self.assertEqual(response.status_code, 200)
        config = create.await_args.args[0]
        self.assertEqual(config.start_period, 1)
        self.assertEqual(config.start_clock, "12:00")

    def test_replay_session_can_omit_game_id_for_highlight_clips(self):
        client = TestClient(main.app)
        fake_session = SimpleNamespace(
            session_id="session-highlight",
            status="ready",
            config=SimpleNamespace(source_type="replay_file"),
            kb=SimpleNamespace(team_names=[], warnings=[]),
            events=[],
        )
        with patch.object(main.live_sessions, "create_session", AsyncMock(return_value=fake_session)) as create:
            response = client.post(
                "/live/sessions",
                json={
                    "source_type": "replay_file",
                    "file_url": "https://example.test/highlight.mp4",
                },
            )
        self.assertEqual(response.status_code, 200)
        config = create.await_args.args[0]
        self.assertEqual(config.nba_game_id, "")

    def test_youtube_live_session_rejects_missing_youtube_source(self):
        client = TestClient(main.app)
        response = client.post(
            "/live/sessions",
            json={
                "source_type": "youtube_embed",
                "nba_game_id": "0022300157",
                "start_period": 1,
                "start_clock": "12:00",
            },
        )
        self.assertEqual(response.status_code, 422)

    def test_youtube_watch_recorded_session_uses_replay_media_clock(self):
        client = TestClient(main.app)
        fake_session = SimpleNamespace(
            session_id="session-watch",
            status="ready",
            config=SimpleNamespace(source_type="youtube_watch"),
            kb=SimpleNamespace(team_names=["WAS", "CHA"], warnings=[]),
            events=[],
        )
        with patch.object(main.live_sessions, "create_session", AsyncMock(return_value=fake_session)) as create:
            response = client.post(
                "/live/sessions",
                json={
                    "source_type": "youtube_watch",
                    "youtube_video_id": "dQw4w9WgXcQ",
                    "nba_game_id": "0022300157",
                    "start_period": 1,
                    "start_clock": "11:42",
                    "clock_mode": "replay_media",
                },
            )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["source_type"], "youtube_watch")
        config = create.await_args.args[0]
        self.assertIsNone(config.file_url)
        self.assertEqual(config.clock_mode, "replay_media")

    def test_playback_control_accepts_duration_for_youtube_watch(self):
        client = TestClient(main.app)
        with patch.object(main.live_sessions, "control_playback", AsyncMock(return_value=True)) as control:
            response = client.post(
                "/live/sessions/session-1/playback",
                json={
                    "state": "playing",
                    "replay_time_sec": 18.5,
                    "playback_rate": 1,
                    "duration_sec": 95.25,
                },
            )
        self.assertEqual(response.status_code, 200)
        control.assert_awaited_once_with(
            "session-1",
            state="playing",
            replay_time_sec=18.5,
            playback_rate=1,
            duration_sec=95.25,
        )

    def test_live_game_detection_endpoint_is_removed(self):
        client = TestClient(main.app)
        response = client.post("/live/games/detect", json={})
        self.assertEqual(response.status_code, 404)

    def test_live_game_search_uses_short_timeout_and_cache(self):
        client = TestClient(main.app)
        main._live_game_search_cache.clear()
        result = LiveGameSearchResult(
            game_id="0022300157",
            game_date="2023-11-08",
            season="2023-24",
            season_type="Regular Season",
            matchup="WAS @ CHA",
            team_abbreviation="WAS",
            opponent_abbreviation="CHA",
            home_team="CHA",
            away_team="WAS",
            team_score=132,
            opponent_score=116,
            score="132-116",
            result="W",
        )
        with patch.object(main, "search_nba_games", return_value=[result]) as search:
            response = client.get(
                "/live/games/search",
                params={
                    "team": "WAS",
                    "opponent": "CHA",
                    "season": "2023-24",
                    "season_type": "Regular Season",
                },
            )
            cached_response = client.get(
                "/live/games/search",
                params={
                    "team": "was",
                    "opponent": "cha",
                    "season": "2023-24",
                    "season_type": "Regular Season",
                },
            )
        main._live_game_search_cache.clear()

        self.assertEqual(response.status_code, 200)
        self.assertEqual(cached_response.status_code, 200)
        self.assertEqual(response.json()[0]["game_id"], "0022300157")
        search.assert_called_once()
        self.assertEqual(search.call_args.kwargs["timeout"], 6)

    def test_live_game_search_normalizes_stats_nba_timeout(self):
        client = TestClient(main.app)
        main._live_game_search_cache.clear()
        raw_timeout = (
            "HTTPSConnectionPool(host='stats.nba.com', port=443): "
            "Read timed out. (read timeout=6)"
        )
        with patch.object(main, "search_nba_games", side_effect=RuntimeError(raw_timeout)):
            response = client.get(
                "/live/games/search",
                params={
                    "team": "WAS",
                    "opponent": "CHA",
                    "season": "2023-24",
                    "season_type": "Regular Season",
                },
            )
        main._live_game_search_cache.clear()

        self.assertEqual(response.status_code, 504)
        self.assertEqual(
            response.json()["detail"],
            "NBA game search timed out. Enter the game ID manually or try again.",
        )

    def test_live_persist_failure_logs_response_body(self):
        response = main.httpx.Response(400, text='{"message":"missing column source_type"}')
        with self.assertLogs("vision2voice", level="WARNING") as logs:
            main.log_live_persist_failure(response, "session_ready")
        self.assertIn("HTTP 400", "\n".join(logs.output))
        self.assertIn("missing column source_type", "\n".join(logs.output))

    def test_live_persistence_stores_caption_update_metadata(self):
        posts = []

        class FakeAsyncClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return None

            async def post(self, url, *, headers, json):
                posts.append((url, json))
                return main.httpx.Response(201)

        event = {
            "type": "caption_update",
            "event_id": "evt-1",
            "period": 1,
            "clock": "11:59",
            "event_type": "made_shot",
            "text": "Enriched caption.",
            "source": "feed",
            "confidence": 0.9,
            "latency_ms": 42,
            "model_name": "mock-model",
            "caption_stage": "enriched",
            "generated_at": "2026-05-10T19:20:00+00:00",
            "enriched_from_event_id": "evt-1",
        }

        env = {
            "SUPABASE_URL": "https://example.supabase.co",
            "SUPABASE_SERVICE_ROLE_KEY": "key",
        }
        with patch.dict(main.os.environ, env), patch.object(main.httpx, "AsyncClient", FakeAsyncClient):
            asyncio.run(main.persist_live_event_to_supabase("d8d3b9ef-5692-448b-b7a5-5cf606981fa5", event))

        self.assertEqual(len(posts), 1)
        self.assertTrue(posts[0][0].endswith("/rest/v1/live_captions"))
        payload = posts[0][1]
        self.assertEqual(payload["caption_stage"], "enriched")
        self.assertEqual(payload["generated_at"], "2026-05-10T19:20:00+00:00")
        self.assertEqual(payload["enriched_from_event_id"], "evt-1")


if __name__ == "__main__":
    unittest.main()
