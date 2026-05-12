# Browser Extension

Vision2Voice includes a Chrome Manifest V3 extension popup for YouTube watch pages. The popup configures sessions and displays generated captions; a content script only syncs YouTube playback time for recorded-video alignment.

## What V1 Supports

- Chrome / Chromium through Manifest V3.
- YouTube watch and live pages.
- NBA recorded videos, using YouTube player time plus the replay clock fallback.
- NBA live streams, using new official play-by-play feed events.
- Feed/template captions plus optional OpenAI text enrichment.

V1 does not download YouTube media, sample YouTube frames, or caption arbitrary non-NBA videos. YouTube sessions are feed-only because the extension and backend do not have raw video-frame access from embedded or watch-page playback.

## Local Setup

Run the backend first:

```bash
npm run dev:backend
```

Build the extension:

```bash
npm run build:extension
```

Load it in Chrome:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select `dist-extension/`.
5. Open a YouTube video or live stream.

The Vision2Voice toolbar popup defaults to:

```text
http://127.0.0.1:8000
```

Change the backend field in the popup if your API is hosted somewhere else.

## Recorded YouTube Video Flow

1. Open the YouTube video.
2. Click the Vision2Voice extension icon to open the popup.
3. Choose **Recorded**.
4. Search for the NBA matchup or paste a game ID.
5. Enter the period and game clock corresponding to the start of the YouTube video.
6. Click **Start**.
7. Keep or reopen the popup to see generated captions. Play, pause, seek, or change speed in YouTube; the extension sends player time to the backend.

The backend creates a `youtube_watch` session with `clock_mode: "replay_media"` and emits captions when the supplied player time crosses matching play-by-play events.

## Live YouTube Flow

1. Open the YouTube live stream.
2. Click the Vision2Voice extension icon to open the popup.
3. Choose **Live Feed**.
4. Search for or enter the active NBA game ID.
5. Click **Start**.

The backend creates a `youtube_watch` session with `clock_mode: "feed_live"` and polls NBA play-by-play for newly observed events. Completed games may show no new captions because existing events are seeded as already seen.

Generated captions are shown only inside the extension popup. The extension does not add floating panels or video overlays to the YouTube page.

## Backend API Surface

Extension sessions use the existing live API:

```json
{
  "source_type": "youtube_watch",
  "youtube_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "youtube_video_id": "dQw4w9WgXcQ",
  "nba_game_id": "0022300157",
  "clock_mode": "replay_media",
  "cadence_sec": 1,
  "window_sec": 2,
  "include_knowledge": false
}
```

Recorded sessions also call playback control:

```json
{
  "state": "playing",
  "replay_time_sec": 24.2,
  "playback_rate": 1,
  "duration_sec": 1800
}
```

## Limitations

- The extension needs a reachable FastAPI backend.
- The backend needs network access to stats.nba.com through `nba_api`.
- Recorded YouTube captions are only as aligned as the backend replay clock fallback because the extension does not expose raw YouTube frames for scorebug detection.
- YouTube player page structure can change; the content script looks for the standard `video.html5-main-video` element for recorded-video playback sync.
