import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

import main


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
        )

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

    def test_live_persist_failure_logs_response_body(self):
        response = main.httpx.Response(400, text='{"message":"missing column source_type"}')
        with self.assertLogs("vision2voice", level="WARNING") as logs:
            main.log_live_persist_failure(response, "session_ready")
        self.assertIn("HTTP 400", "\n".join(logs.output))
        self.assertIn("missing column source_type", "\n".join(logs.output))


if __name__ == "__main__":
    unittest.main()
