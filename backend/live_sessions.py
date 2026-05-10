"""In-memory live replay session manager and SSE event producer."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import tempfile
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable
from urllib.parse import urlparse

import httpx

from live_game_data import (
    GameDataProvider,
    LiveGameEvent,
    NBAApiGameDataProvider,
    align_replay_time,
    game_elapsed_sec,
)
from live_kb import PregameKnowledgeBase, build_pregame_kb
from live_state import CaptionDecision, FeedContext, LiveStateReconciler, VisualObservation

logger = logging.getLogger("vision2voice.live.sessions")


@dataclass(slots=True)
class LiveSessionConfig:
    nba_game_id: str
    start_period: int
    start_clock: str
    file_url: str | None = None
    cadence_sec: float = 1.0
    window_sec: float = 2.0
    replay_speed: float = 1.0
    clock_mode: str = "replay_media"
    source_type: str = "replay_file"
    youtube_url: str | None = None
    youtube_video_id: str | None = None
    demo_feed_events: bool = False
    include_knowledge: bool = False


@dataclass
class LiveSession:
    session_id: str
    config: LiveSessionConfig
    kb: PregameKnowledgeBase
    events: list[LiveGameEvent]
    created_at: float = field(default_factory=time.time)
    status: str = "created"
    stopped: bool = False
    subscribers: set[asyncio.Queue[dict[str, Any]]] = field(default_factory=set)
    replay_task: asyncio.Task[None] | None = None
    started_at: float | None = None
    ended_at: float | None = None
    duration_sec: float | None = None
    replay_elapsed: float = 0.0
    playback_rate: float = 1.0
    current_period: int = 1
    current_clock: str = "12:00"
    current_score: str | None = None
    playback_condition: asyncio.Condition = field(default_factory=asyncio.Condition)
    playback_revision: int = 0
    enrichment_tasks: set[asyncio.Task[None]] = field(default_factory=set)


class LiveSessionManager:
    def __init__(
        self,
        provider: GameDataProvider | None = None,
        event_sink: Callable[[str, dict[str, Any]], Awaitable[None]] | None = None,
    ):
        self.provider = provider or NBAApiGameDataProvider()
        self.event_sink = event_sink
        self.sessions: dict[str, LiveSession] = {}
        self._initial_package_cache: dict[tuple[str, bool], LiveGamePackage] = {}

    async def create_session(self, config: LiveSessionConfig) -> LiveSession:
        package = await self._load_initial_game_package(config)
        kb = build_pregame_kb(package, include_knowledge=config.include_knowledge)
        session = LiveSession(
            session_id=str(uuid.uuid4()),
            config=config,
            kb=kb,
            events=package.events,
            status="ready",
            current_period=config.start_period,
            current_clock=config.start_clock,
        )
        self.sessions[session.session_id] = session
        session.replay_task = asyncio.create_task(self._run_session(session))
        await self._broadcast(
            session,
            {
                "type": "session_ready",
                "session_id": session.session_id,
                "status": session.status,
                "source_type": config.source_type,
                "game_id": config.nba_game_id,
                "file_url": config.file_url,
                "source_url": session_source_url(config),
                "youtube_video_id": config.youtube_video_id,
                "start_period": config.start_period,
                "start_clock": config.start_clock,
                "cadence_sec": config.cadence_sec,
                "window_sec": config.window_sec,
                "clock_mode": config.clock_mode,
                "replay_time_sec": session.replay_elapsed,
                "playback_rate": session.playback_rate,
                "team_names": kb.team_names,
                "event_count": len(package.events),
                "warnings": kb.warnings,
            },
        )
        return session

    def get_session(self, session_id: str) -> LiveSession | None:
        return self.sessions.get(session_id)

    async def stop_session(self, session_id: str) -> bool:
        session = self.sessions.get(session_id)
        if not session:
            return False
        session.stopped = True
        session.status = "stopping"
        async with session.playback_condition:
            session.playback_condition.notify_all()
        await self._broadcast(session, {"type": "status", "session_id": session_id, "status": "stopping"})
        return True

    async def control_playback(
        self,
        session_id: str,
        *,
        state: str,
        replay_time_sec: float,
        playback_rate: float,
    ) -> bool:
        session = self.sessions.get(session_id)
        if not session:
            return False
        if session.status in {"stopping", "stopped", "complete", "error"}:
            return True

        rate = min(8.0, max(0.1, float(playback_rate or 1.0)))
        replay_elapsed = max(0.0, float(replay_time_sec or 0.0))
        if session.duration_sec is not None:
            replay_elapsed = min(session.duration_sec, replay_elapsed)

        session.replay_elapsed = replay_elapsed
        session.playback_rate = rate
        session.status = "running" if state == "playing" else "paused"
        session.playback_revision += 1
        if state == "playing":
            session.started_at = time.time() - (replay_elapsed / rate)

        async with session.playback_condition:
            session.playback_condition.notify_all()

        await self._broadcast(
            session,
            {
                "type": "status",
                "session_id": session_id,
                "status": session.status,
                "replay_time_sec": session.replay_elapsed,
                "duration_sec": session.duration_sec,
                "playback_rate": session.playback_rate,
                "clock_mode": session.config.clock_mode,
            },
        )
        await self._emit_tick(session)
        return True

    async def _run_session(self, session: LiveSession) -> None:
        if session.config.clock_mode == "feed_live" or session.config.source_type == "youtube_embed":
            await self._run_feed_live(session)
            return
        await self._run_replay(session)

    async def event_stream(self, session_id: str) -> AsyncIterator[str]:
        session = self.sessions.get(session_id)
        if not session:
            yield _sse({"type": "error", "error": "Unknown live session"})
            return
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        session.subscribers.add(queue)
        await queue.put(
            {
                "type": "connected",
                "session_id": session_id,
                "status": session.status,
                "source_type": session.config.source_type,
                "clock_mode": session.config.clock_mode,
                "team_names": session.kb.team_names,
            }
        )
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield _sse({"type": "ping", "session_id": session_id})
                    continue
                yield _sse(event)
                if event.get("type") in {"complete", "stopped", "error"}:
                    break
        finally:
            session.subscribers.discard(queue)

    async def _run_replay(self, session: LiveSession) -> None:
        config = session.config
        video_path = ""
        try:
            if not config.file_url:
                raise RuntimeError("Replay sessions require a file_url.")
            video_path = await _download_video_temp(config.file_url)
            duration = await asyncio.to_thread(_video_duration_sec, video_path)
            session.duration_sec = duration
            reconciler = LiveStateReconciler(session.kb)
            start_abs = game_elapsed_sec(config.start_period, config.start_clock)
            previous_signature: str | None = None
            should_process_immediate = True
            last_playback_revision = session.playback_revision
            await self._emit_tick(session)

            while session.replay_elapsed < duration and not session.stopped:
                async with session.playback_condition:
                    await session.playback_condition.wait_for(
                        lambda: session.stopped or session.status == "running"
                    )
                if session.stopped:
                    break

                if not should_process_immediate:
                    sleep_for = config.cadence_sec / max(0.1, session.playback_rate)
                    try:
                        async with session.playback_condition:
                            await asyncio.wait_for(
                                session.playback_condition.wait_for(
                                    lambda: session.stopped
                                    or session.status != "running"
                                    or session.playback_revision != last_playback_revision
                                ),
                                timeout=sleep_for,
                            )
                    except asyncio.TimeoutError:
                        session.replay_elapsed = min(duration, session.replay_elapsed + config.cadence_sec)
                    else:
                        last_playback_revision = session.playback_revision
                        if session.stopped or session.status != "running":
                            continue
                        should_process_immediate = True
                else:
                    last_playback_revision = session.playback_revision
                should_process_immediate = False

                period, clock, game_abs = align_replay_time(
                    config.start_period,
                    config.start_clock,
                    session.replay_elapsed,
                )
                window_start_abs = max(start_abs, game_abs - config.window_sec)
                matching_events = [
                    e
                    for e in session.events
                    if window_start_abs <= e.game_elapsed_sec <= game_abs
                ]
                feed_events = reconciler.unseen_feed_events(matching_events)
                feed_context = build_feed_context(
                    session.events,
                    game_abs=game_abs,
                    period=period,
                    clock=clock,
                    team_names=session.kb.team_names,
                )

                if feed_events:
                    for event in feed_events:
                        decision = reconciler.fast_caption_for_feed_event(
                            event,
                            replay_time_sec=session.replay_elapsed,
                            visual=None,
                        )
                        decision.latency_ms = _latency_ms(session.started_at, decision.replay_time_sec, session.playback_rate)
                        await self._emit_caption(session, decision)
                        self._schedule_caption_enrichment(
                            session,
                            reconciler,
                            event,
                            replay_time_sec=session.replay_elapsed,
                            initial_text=decision.text,
                            visual_args=(
                                video_path,
                                max(0.0, session.replay_elapsed - config.window_sec),
                                session.replay_elapsed,
                                previous_signature,
                            ),
                        )
                else:
                    visual = await self._visual_observation(
                        video_path,
                        max(0.0, session.replay_elapsed - config.window_sec),
                        session.replay_elapsed,
                        previous_signature=previous_signature,
                        force=False,
                    )
                    previous_signature = visual.summary if visual else previous_signature
                    decision = await reconciler.caption_for_feed_context(
                        period=period,
                        clock=clock,
                        replay_time_sec=session.replay_elapsed,
                        visual=visual,
                        context=feed_context,
                    )
                    if decision:
                        decision.latency_ms = _latency_ms(session.started_at, decision.replay_time_sec, session.playback_rate)
                        await self._emit_caption(session, decision)

                await self._emit_tick(session)

            session.ended_at = time.time()
            session.status = "stopped" if session.stopped else "complete"
            await self._broadcast(
                session,
                {
                    "type": session.status,
                    "session_id": session.session_id,
                    "status": session.status,
                    "duration_sec": duration,
                },
            )
        except Exception as exc:
            logger.exception("Live replay failed")
            session.status = "error"
            await self._broadcast(
                session,
                {"type": "error", "session_id": session.session_id, "error": str(exc)},
            )
        finally:
            await self._cancel_enrichment_tasks(session)
            if video_path:
                try:
                    Path(video_path).unlink()
                except OSError:
                    pass

    async def _run_feed_live(self, session: LiveSession) -> None:
        config = session.config
        reconciler = LiveStateReconciler(session.kb)
        reconciler.seen_event_ids.update(event.event_id for event in session.events)
        demo_emitted = False
        if session.events:
            latest = session.events[-1]
            session.current_period = latest.period
            session.current_clock = latest.clock
            session.current_score = latest.score
            session.replay_elapsed = latest.game_elapsed_sec

        try:
            session.status = "running"
            session.started_at = time.time()
            await self._broadcast(
                session,
                {
                    "type": "status",
                    "session_id": session.session_id,
                    "status": session.status,
                    "source_type": config.source_type,
                    "source_url": session_source_url(config),
                    "youtube_video_id": config.youtube_video_id,
                    "clock_mode": config.clock_mode,
                },
            )
            await self._emit_tick(session)

            while not session.stopped:
                await asyncio.sleep(config.cadence_sec)
                if session.stopped:
                    break

                if config.demo_feed_events and demo_feed_allowed() and not demo_emitted:
                    demo_event = build_demo_feed_event(session)
                    session.events = [*session.events, demo_event]
                    session.current_period = demo_event.period
                    session.current_clock = demo_event.clock
                    session.current_score = demo_event.score
                    session.replay_elapsed = demo_event.game_elapsed_sec
                    decision = reconciler.fast_caption_for_feed_event(
                        demo_event,
                        replay_time_sec=demo_event.game_elapsed_sec,
                        visual=None,
                    )
                    await self._emit_caption(session, decision)
                    self._schedule_caption_enrichment(
                        session,
                        reconciler,
                        demo_event,
                        replay_time_sec=demo_event.game_elapsed_sec,
                        initial_text=decision.text,
                    )
                    await self._emit_tick(session)
                    demo_emitted = True
                    continue

                try:
                    package = await self._load_game_package(config)
                except Exception as exc:
                    warning = f"NBA play-by-play poll failed: {exc}"
                    logger.warning(warning)
                    if warning not in session.kb.warnings:
                        session.kb.warnings.append(warning)
                    await self._broadcast(
                        session,
                        {
                            "type": "status",
                            "session_id": session.session_id,
                            "status": session.status,
                            "warning": warning,
                            "clock_mode": config.clock_mode,
                        },
                    )
                    continue

                if package.teams or package.players or package.warnings:
                    session.kb = build_pregame_kb(package, include_knowledge=config.include_knowledge)
                session.events = package.events
                if session.events:
                    latest = session.events[-1]
                    session.current_period = latest.period
                    session.current_clock = latest.clock
                    session.current_score = latest.score
                    session.replay_elapsed = latest.game_elapsed_sec

                feed_events = reconciler.unseen_feed_events(session.events)
                for event in feed_events:
                    decision = reconciler.fast_caption_for_feed_event(
                        event,
                        replay_time_sec=event.game_elapsed_sec,
                        visual=None,
                    )
                    await self._emit_caption(session, decision)
                    self._schedule_caption_enrichment(
                        session,
                        reconciler,
                        event,
                        replay_time_sec=event.game_elapsed_sec,
                        initial_text=decision.text,
                    )
                await self._emit_tick(session)

            session.ended_at = time.time()
            session.status = "stopped"
            await self._broadcast(
                session,
                {
                    "type": "stopped",
                    "session_id": session.session_id,
                    "status": session.status,
                    "clock_mode": config.clock_mode,
                },
            )
        except Exception as exc:
            logger.exception("Feed-live session failed")
            session.status = "error"
            await self._broadcast(
                session,
                {"type": "error", "session_id": session.session_id, "error": str(exc)},
            )
        finally:
            await self._cancel_enrichment_tasks(session)

    async def _load_game_package(self, config: LiveSessionConfig):
        try:
            return await asyncio.to_thread(
                self.provider.load_game,
                config.nba_game_id,
                include_knowledge=config.include_knowledge,
            )
        except TypeError as exc:
            if "include_knowledge" not in str(exc):
                raise
            return await asyncio.to_thread(self.provider.load_game, config.nba_game_id)

    async def _load_initial_game_package(self, config: LiveSessionConfig):
        cache_key = (config.nba_game_id, config.include_knowledge)
        if config.source_type == "replay_file" and cache_key in self._initial_package_cache:
            return self._initial_package_cache[cache_key]
        try:
            package = await asyncio.wait_for(
                self._load_game_package(config),
                timeout=_env_float("LIVE_GAME_LOAD_TIMEOUT_SEC", 14.0),
            )
        except asyncio.TimeoutError as exc:
            raise TimeoutError(
                "NBA play-by-play loading timed out. Try again or use the manual game ID after confirming it."
            ) from exc
        if config.source_type == "replay_file":
            self._initial_package_cache[cache_key] = package
        return package

    def _schedule_caption_enrichment(
        self,
        session: LiveSession,
        reconciler: LiveStateReconciler,
        event: LiveGameEvent,
        *,
        replay_time_sec: float,
        initial_text: str,
        visual_args: tuple[str, float, float, str | None] | None = None,
    ) -> None:
        if not os.getenv("OPENAI_API_KEY") and visual_args is None:
            return
        task = asyncio.create_task(
            self._enrich_feed_caption(
                session,
                reconciler,
                event,
                replay_time_sec=replay_time_sec,
                initial_text=initial_text,
                visual_args=visual_args,
            )
        )
        session.enrichment_tasks.add(task)
        task.add_done_callback(session.enrichment_tasks.discard)

    async def _enrich_feed_caption(
        self,
        session: LiveSession,
        reconciler: LiveStateReconciler,
        event: LiveGameEvent,
        *,
        replay_time_sec: float,
        initial_text: str,
        visual_args: tuple[str, float, float, str | None] | None,
    ) -> None:
        visual: VisualObservation | None = None
        try:
            if visual_args is not None:
                video_path, t0, t1, previous_signature = visual_args
                visual = await asyncio.wait_for(
                    self._visual_observation(
                        video_path,
                        t0,
                        t1,
                        previous_signature=previous_signature,
                        force=True,
                    ),
                    timeout=_env_float("LIVE_VISION_TIMEOUT_SEC", 1.5),
                )
            if not os.getenv("OPENAI_API_KEY") and visual is None:
                return
            decision = await asyncio.wait_for(
                reconciler.enriched_caption_for_feed_event(
                    event,
                    replay_time_sec=replay_time_sec,
                    visual=visual,
                    recent_captions=list(reconciler.recent_captions),
                ),
                timeout=_env_float("LIVE_CAPTION_ENRICH_TIMEOUT_SEC", 2.0),
            )
            if decision.text.strip() == initial_text.strip() and not decision.visual_summary:
                return
            decision.latency_ms = _latency_ms(session.started_at, decision.replay_time_sec, session.playback_rate)
            await self._emit_caption(session, decision, event_type="caption_update")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("Live caption enrichment skipped: %s", exc)

    async def _cancel_enrichment_tasks(self, session: LiveSession) -> None:
        if not session.enrichment_tasks:
            return
        tasks = list(session.enrichment_tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        session.enrichment_tasks.clear()

    async def _visual_observation(
        self,
        video_path: str,
        t0: float,
        t1: float,
        *,
        previous_signature: str | None,
        force: bool,
    ) -> VisualObservation | None:
        signature, changed = await asyncio.to_thread(_frame_change_signature, video_path, t0, t1)
        if not force and not changed:
            return None
        if not os.getenv("OPENAI_API_KEY") or os.getenv("LIVE_VISION_ENABLED", "1").lower() in {"0", "false", "no"}:
            summary = "players move through the possession as the defense reacts."
            action_level = "medium"
            if changed:
                summary = "the action changes pace with movement around the ball."
            else:
                summary = "players hold their spacing while the possession resets."
                action_level = "low"
            return VisualObservation(summary=summary, confidence=0.42, changed=changed, action_level=action_level)
        # Keep v1 latency predictable: the expensive live vision call is intentionally tiny.
        try:
            summary, confidence, action_level = await live_vision_summary(video_path, t0, t1)
            changed = changed or (summary != previous_signature)
            return VisualObservation(summary=summary, confidence=confidence, changed=changed, action_level=action_level)
        except Exception as exc:
            logger.warning("Live vision summary failed: %s", exc)
            return VisualObservation(
                summary=signature or "visual context unavailable.",
                confidence=0.3,
                changed=changed,
                action_level="medium" if changed else "low",
            )

    async def _emit_caption(
        self,
        session: LiveSession,
        decision: CaptionDecision,
        *,
        event_type: str = "caption",
    ) -> None:
        await self._broadcast(
            session,
            {
                "type": event_type,
                "session_id": session.session_id,
                **asdict(decision),
            },
        )

    async def _emit_tick(self, session: LiveSession) -> None:
        if session.config.clock_mode == "feed_live":
            period = session.current_period
            clock = session.current_clock
        else:
            period, clock, _ = align_replay_time(
                session.config.start_period,
                session.config.start_clock,
                session.replay_elapsed,
            )
            session.current_period = period
            session.current_clock = clock
        await self._broadcast(
            session,
            {
                "type": "tick",
                "session_id": session.session_id,
                "source_type": session.config.source_type,
                "replay_time_sec": session.replay_elapsed,
                "duration_sec": session.duration_sec or 0,
                "period": period,
                "clock": clock,
                "score": session.current_score,
                "event_count": len(session.events),
                "playback_rate": session.playback_rate,
                "clock_mode": session.config.clock_mode,
            },
        )

    async def _broadcast(self, session: LiveSession, event: dict[str, Any]) -> None:
        if self.event_sink:
            try:
                await self.event_sink(session.session_id, event)
            except Exception:
                logger.warning("Live event sink failed", exc_info=True)
        for queue in list(session.subscribers):
            await queue.put(event)


async def _download_video_temp(file_url: str) -> str:
    local_upload = _local_live_upload_path(file_url)
    if local_upload:
        return str(local_upload)
    try:
        async with httpx.AsyncClient(timeout=45.0, follow_redirects=True) as client:
            r = await client.get(file_url)
            r.raise_for_status()
    except httpx.TimeoutException as exc:
        raise RuntimeError("Replay video download timed out. Try a smaller clip or use local upload.") from exc
    except httpx.HTTPError as exc:
        raise RuntimeError(f"Replay video download failed: {exc}") from exc
    fd, path = tempfile.mkstemp(suffix=".mp4")
    os.close(fd)
    Path(path).write_bytes(r.content)
    return path


def _local_live_upload_path(file_url: str) -> Path | None:
    parsed = urlparse(file_url)
    match = re.fullmatch(r"/live/uploads/([a-f0-9]{32})", parsed.path)
    if not match:
        return None
    upload_dir = Path(tempfile.gettempdir()) / "vision2voice-live-uploads"
    matches = list(upload_dir.glob(f"{match.group(1)}.*"))
    if not matches:
        raise RuntimeError("Replay upload not found. Upload the file again and restart the session.")
    return matches[0]


def _video_duration_sec(video_path: str) -> float:
    import cv2

    cap = cv2.VideoCapture(video_path)
    try:
        if not cap.isOpened():
            raise RuntimeError("Could not open replay video")
        frames = float(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 0)
        if frames > 0 and fps > 0:
            return max(0.1, frames / fps)
        return 30.0
    finally:
        cap.release()


def _frame_change_signature(video_path: str, t0: float, t1: float) -> tuple[str, bool]:
    import cv2

    cap = cv2.VideoCapture(video_path)
    try:
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 30.0)
        samples = [max(0.0, t0), max(0.0, (t0 + t1) / 2), max(0.0, t1)]
        means: list[float] = []
        for sec in samples:
            cap.set(cv2.CAP_PROP_POS_FRAMES, int(sec * fps))
            ok, frame = cap.read()
            if not ok or frame is None:
                continue
            small = cv2.resize(frame, (32, 18))
            gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
            means.append(float(gray.mean()))
        if len(means) < 2:
            return "visual context unavailable.", False
        spread = max(means) - min(means)
        return f"frame luminance changed by {spread:.1f} points.", spread > 4.5
    finally:
        cap.release()


async def live_vision_summary(video_path: str, t0: float, t1: float) -> tuple[str, float, str]:
    import base64
    import cv2
    from openai import AsyncOpenAI

    cap = cv2.VideoCapture(video_path)
    frames: list[str] = []
    try:
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 30.0)
        for sec in [t0, (t0 + t1) / 2, t1]:
            cap.set(cv2.CAP_PROP_POS_FRAMES, int(max(0.0, sec) * fps))
            ok, frame = cap.read()
            if not ok or frame is None:
                continue
            _, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
            frames.append("data:image/jpeg;base64," + base64.standard_b64encode(buf).decode("ascii"))
    finally:
        cap.release()
    if not frames:
        return "visual context unavailable.", 0.2, "low"

    content: list[dict[str, Any]] = [
        {
            "type": "text",
            "text": (
                "Briefly describe the visible basketball action in this short live window. "
                "Focus on concrete player actions and basketball moves: ball-handler body movement, "
                "drives, pull-ups, step-backs, cuts, screens, slips, passes, shots, rebounds, loose balls, "
                "offensive spacing, defensive coverage, help rotations, contests, and resets. "
                "Use compact broadcast language instead of generic phrases like 'the play continues.' "
                "Do not name a player or scoring result unless clearly visible. "
                "Classify action_level as high for shots/drives/loose balls/fast breaks, medium for normal "
                "half-court movement or screening, and low for resets, standing, walking, dead-ball, or sparse action. "
                'Return JSON: {"summary": string max 22 words, "confidence": number 0-1, '
                '"action_level": "high"|"medium"|"low"}.'
            ),
        }
    ]
    for url in frames:
        content.append({"type": "image_url", "image_url": {"url": url, "detail": "low"}})
    client = AsyncOpenAI()
    resp = await client.chat.completions.create(
        model=os.getenv("OPENAI_VISION_MODEL", "gpt-4o-mini"),
        messages=[{"role": "user", "content": content}],
        response_format={"type": "json_object"},
        max_tokens=100,
    )
    data = json.loads(resp.choices[0].message.content or "{}")
    action_level = str(data.get("action_level") or "medium").strip().lower()
    if action_level not in {"high", "medium", "low"}:
        action_level = "medium"
    return (
        str(data.get("summary") or "the possession continues.").strip(),
        float(data.get("confidence") or 0.4),
        action_level,
    )


def _latency_ms(started_at: float | None, replay_time_sec: float, replay_speed: float) -> int:
    if not started_at:
        return 0
    expected_wall = replay_time_sec / max(0.1, replay_speed)
    return max(0, int((time.time() - started_at - expected_wall) * 1000))


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def build_feed_context(
    events: list[LiveGameEvent],
    *,
    game_abs: float,
    period: int,
    clock: str,
    team_names: list[str],
) -> FeedContext:
    prior: LiveGameEvent | None = None
    next_event: LiveGameEvent | None = None
    last_score: str | None = None
    for event in events:
        if event.game_elapsed_sec <= game_abs:
            prior = event
            if event.score:
                last_score = event.score
            continue
        next_event = event
        break
    if last_score is None:
        for event in reversed(events):
            if event.game_elapsed_sec <= game_abs and event.score:
                last_score = event.score
                break
    return FeedContext(
        period=period,
        clock=clock,
        team_names=team_names,
        nearest_prior=prior,
        nearest_next=next_event,
        last_score=last_score,
    )


def _sse(event: dict[str, Any]) -> str:
    event_name = str(event.get("type") or "message")
    return f"event: {event_name}\ndata: {json.dumps(event)}\n\n"


def session_source_url(config: LiveSessionConfig) -> str | None:
    if config.source_type == "youtube_embed":
        return config.youtube_url or (
            f"https://www.youtube.com/watch?v={config.youtube_video_id}" if config.youtube_video_id else None
        )
    return config.file_url


def demo_feed_allowed() -> bool:
    return os.getenv("LIVE_FEED_DEMO_ENABLED", "").lower() in {"1", "true", "yes", "on"}


def build_demo_feed_event(session: LiveSession) -> LiveGameEvent:
    team_name = session.kb.team_names[0] if session.kb.team_names else "Demo Team"
    period = session.current_period or session.config.start_period
    clock = session.current_clock or session.config.start_clock
    elapsed = max(session.replay_elapsed, game_elapsed_sec(period, clock)) + 0.1
    return LiveGameEvent(
        event_id=f"demo-feed-{session.session_id}",
        period=period,
        clock=clock,
        game_elapsed_sec=elapsed,
        event_type="made_shot",
        description=f"{team_name} demo feed event: made jump shot",
        team_name=team_name,
        score=session.current_score,
    )
