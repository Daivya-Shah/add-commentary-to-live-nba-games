# Live Replay and YouTube Feed-Live

The `/live` screen supports two live-caption modes and requires direct FastAPI mode.

- **Replay File:** a prerecorded basketball video is uploaded or supplied by URL, then captioned as simulated live playback.
- **YouTube Feed-Live:** an embedded YouTube broadcast/video plays in the app while captions are generated only from NBA play-by-play feed events. Embedded YouTube sources are not downloaded, sampled, or analyzed with vision.

## Requirements

- Root `.env` includes `VITE_BACKEND_URL`.
- Backend is running and reachable from the browser.
- `nba_api` can reach stats.nba.com.
- Replay File mode requires video accessible by the backend, either through URL mode or local upload mode.
- `OPENAI_API_KEY` is optional but required for AI-generated live vision/text. Template/feed behavior can run without it.
- YouTube Feed-Live mode requires a YouTube video ID or URL and an NBA game ID. It does not require `file_url`.
- Local demo feed captions require `LIVE_FEED_DEMO_ENABLED=1` on the backend and the dev-only Demo feed events control in YouTube mode.

## User Flow

1. Open `/live`.
2. Choose upload mode, URL mode, or YouTube mode.
3. Search NBA games by team, opponent, season, and season type.
4. Select or enter a game ID.
5. For Replay File mode, enter the starting period and clock for replay alignment.
6. Start the session.
7. The UI opens an SSE connection.
8. In Replay File mode, the video player's play/pause/seek events control the replay clock.
9. In YouTube Feed-Live mode, the backend polls NBA play-by-play and emits captions only for newly observed feed events.
10. Stop the session or let the replay complete.

## Inputs

| Input | Meaning |
| --- | --- |
| `source_type` | `replay_file` or `youtube_embed`. Defaults to `replay_file`. |
| `file_url` | Replay File video URL the backend can download. Local upload mode creates this URL through `/live/uploads`. |
| `youtube_url` | YouTube watch/embed/live URL for YouTube Feed-Live mode. |
| `youtube_video_id` | Normalized YouTube video ID for embedding. |
| `demo_feed_events` | Dev/test-only feed-live demo captions when `LIVE_FEED_DEMO_ENABLED=1`. |
| `nba_game_id` | NBA game ID used to load play-by-play and rosters. |
| `start_period` | Period where the replay begins. |
| `start_clock` | Game clock at replay start, for example `11:36`. |
| `cadence_sec` | How often the replay loop emits ticks and evaluates captions. |
| `window_sec` | Visual observation window size. |
| `replay_speed` | Playback speed for the backend replay loop. |
| `clock_mode` | `replay_media` for client-controlled replay playback, or `feed_live` for NBA-feed-driven YouTube sessions. |

## Backend Session Lifecycle

### Replay File

1. `POST /live/sessions` creates a `LiveSession`.
2. The manager downloads or receives the replay video.
3. `live_game_data.py` loads game data and normalizes events.
4. `live_kb.py` builds the pregame knowledge packet from teams and players.
5. The session waits in `ready` until the browser video starts playing.
6. The session loop maps replay seconds to game period/clock while status is `running`.
7. The loop emits `tick` events for UI progress.
8. The reconciler emits `caption` events when feed events or feed context justify one.
9. The stream emits `complete`, `stopped`, or `error`.

### YouTube Feed-Live

1. `POST /live/sessions` creates a session with `source_type: "youtube_embed"` and `clock_mode: "feed_live"`.
2. The manager loads initial NBA play-by-play and marks already-known events as seen.
3. The browser renders the YouTube embed with `enablejsapi=1`.
4. The backend polls NBA play-by-play every `cadence_sec`.
5. Newly observed feed events produce `feed` captions.
6. Ticks use the latest feed event period, clock, score, and event count.
7. Poll failures emit warning/status events; the session does not invent captions while the feed is unavailable.
8. The stream runs until stopped or an unrecoverable error occurs.

Completed games may show an empty feed-live caption panel because existing events are seeded as already seen. In local development, enable demo feed events to verify the visible caption path without waiting for an in-progress game.

In Replay File mode, pausing the video sends `state: "paused"` to the backend, which stops ticks and caption generation. Seeking sends the new video `currentTime`, and the backend emits a tick for the corresponding game clock before continuing. YouTube Feed-Live mode is driven by NBA feed polling, so YouTube player controls do not drive the backend clock.

## Feed and Vision Reconciliation

Live Replay prioritizes structured game data:

- Exact unseen play-by-play events produce `feed` captions.
- Already elapsed feed context can produce `feed_context_with_vision` captions.
- Vision observations can support captions when `LIVE_VISION_ENABLED=1`.
- Vision-only behavior should be cautious because official play-by-play is the source of truth.
- YouTube Feed-Live never emits vision captions because embedded YouTube media does not expose raw frames to the app.

Live captions also extract action detail from official play-by-play descriptions when available, such as driving layups, step-back threes, pull-up jumpers, alley-oops, tip-ins, rebounds, screens, help defense, or reset spacing. Replay File sessions can blend those feed cues with compact visual observations of player movement and coverage. YouTube Feed-Live captions are limited to official feed wording because the backend cannot inspect embedded YouTube video frames.

The frontend displays source labels such as:

| Source | Meaning |
| --- | --- |
| `feed` | Caption is based on an official feed event. |
| `feed_with_vision` | Feed event with visual support. |
| `feed_context_with_vision` | Caption is based on elapsed feed context plus visual observation. |

## SSE Events

The frontend opens:

```text
GET /live/sessions/{session_id}/events
```

Important event types:

- `session_ready`: metadata and warnings.
- `tick`: replay time, duration, period, and clock.
- `caption`: generated caption and metadata.
- `complete`: replay finished.
- `stopped`: stop request completed.
- `error`: failure state.
- `ping`: keepalive.

The frontend also calls:

```text
POST /live/sessions/{session_id}/playback
```

with:

```json
{
  "state": "playing",
  "replay_time_sec": 24.2,
  "playback_rate": 1
}
```

Use `playing` to advance Replay File captions and `paused` to hold them at the current replay position.

## Local Upload Mode

When the backend is available, uploaded replay files are sent to:

```text
POST /live/uploads?filename=replay.mp4
```

The backend writes the file to:

```text
{system-temp}/vision2voice-live-uploads
```

It then serves it back through:

```text
GET /live/uploads/{upload_id}
```

This avoids depending on Supabase Storage limits for larger replay files during local development.

## Game Search

The UI calls:

```text
GET /live/games/search?team=WAS&opponent=CHA&season=2023-24&season_type=Regular%20Season
```

The backend resolves team names/abbreviations, calls NBA game finder APIs, normalizes home/away teams, and returns candidate game IDs.

## Operational Limits

- stats.nba.com access can be rate-limited or blocked by network conditions.
- Replay alignment is only as good as the chosen start period and clock.
- Local upload files are temporary and should not be treated as durable storage.
- SSE streams are in-memory per backend process.
- Multiple backend instances need external session coordination before Live Replay can scale horizontally.

## Recommended Defaults

For local testing:

```json
{
  "cadence_sec": 3,
  "window_sec": 6,
  "replay_speed": 1,
  "clock_mode": "replay_media"
}
```

For faster tests or fixtures, use a higher `replay_speed` and shorter video.

For YouTube Feed-Live:

```json
{
  "source_type": "youtube_embed",
  "clock_mode": "feed_live",
  "cadence_sec": 3,
  "window_sec": 6
}
```
