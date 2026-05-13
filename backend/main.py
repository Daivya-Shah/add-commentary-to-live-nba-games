"""
Vision2Voice analysis API: download clip → frame sampling → vision (OpenAI or fallback)
→ retrieve stats from local knowledge → commentary (OpenAI or template).
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import tempfile
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

from jersey_resolve import enrich_timeline_segments, enrich_vision_with_nba_rosters
from openai_retry import with_openai_retry
from timeline import (
    commentary_lines_for_timeline,
    normalize_timeline,
    template_lines_for_timeline,
    visual_summary_from_timeline,
)
from voiceover_export import build_voiceover_mp4, build_voiceover_timeline_mp4

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("vision2voice")

APP_DIR = Path(__file__).resolve().parent
load_dotenv(APP_DIR / ".env")

KNOWLEDGE_PATH = APP_DIR / "data" / "knowledge.json"

EVENT_TYPES = [
    "Three-Point Shot",
    "Two-Point Shot",
    "Layup or Dunk",
    "Free Throw",
    "Assist",
    "Rebound",
    "Turnover",
    "Block",
    "Foul",
    "Other",
]

app = FastAPI(title="Vision2Voice Backend", version="0.1.0")

_cors_raw = os.getenv("CORS_ORIGINS", "*").strip()
_cors_origins = [o.strip() for o in _cors_raw.split(",") if o.strip()] if _cors_raw != "*" else ["*"]
# Any localhost / 127.0.0.1 port (Vite picks 5173, 8080, 8081, … when busy)
_localhost_regex = r"https?://(localhost|127\.0\.0\.1)(:\d+)?$"

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_origin_regex=None if _cors_origins == ["*"] else _localhost_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ClipRequest(BaseModel):
    clip_id: str
    file_url: str


class VoiceoverExportBody(BaseModel):
    file_url: str
    commentary_text: str = ""
    possession_timeline: list[dict[str, Any]] | None = None
    segment_commentary_lines: list[str] | None = None


def _unlink_temp(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


class AnalysisResult(BaseModel):
    event_type: str
    player_name: str
    team_name: str
    confidence: float = Field(ge=0.0, le=1.0)
    visual_summary: str
    retrieved_context: dict[str, Any] | None = None
    commentary_text: str
    model_name: str = "vision2voice-v1"
    possession_timeline: list[dict[str, Any]] = Field(default_factory=list)
    segment_commentary_lines: list[str] = Field(default_factory=list)


def load_knowledge() -> dict[str, Any]:
    if not KNOWLEDGE_PATH.exists():
        return {"players": [], "teams": []}
    with KNOWLEDGE_PATH.open(encoding="utf-8") as f:
        return json.load(f)


def _normalize(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").lower().strip())


def retrieve_context(player_name: str, team_name: str) -> dict[str, Any]:
    data = load_knowledge()
    pn = _normalize(player_name)
    tn = _normalize(team_name)

    player_stats: dict[str, Any] | None = None
    team_stats: dict[str, Any] | None = None

    for p in data.get("players", []):
        for alias in p.get("aliases", []):
            na = _normalize(alias)
            if na and (na in pn or pn in na or na in pn):
                player_stats = {k: v for k, v in p.items() if k not in ("aliases", "display_name", "notes")}
                player_stats["name"] = p.get("display_name", player_name)
                break
        if player_stats:
            break

    for t in data.get("teams", []):
        for alias in t.get("aliases", []):
            na = _normalize(alias)
            if na and (na in tn or tn in na):
                team_stats = {k: v for k, v in t.items() if k not in ("aliases", "display_name")}
                team_stats["name"] = t.get("display_name", team_name)
                break
        if team_stats:
            break

    return {
        "player_stats": player_stats or {},
        "team_stats": team_stats or {},
    }


def get_video_duration(video_path: str) -> float:
    """Return duration in seconds using OpenCV."""
    import cv2
    cap = cv2.VideoCapture(video_path)
    try:
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
        return max(0.5, total / fps)
    finally:
        cap.release()


def _fmt_time(sec: float) -> str:
    m, s = divmod(int(sec), 60)
    return f"{m}:{s:02d}"


def _target_frame_count(window_sec: float, *, minimum: int = 10, max_frames: int | None = None) -> int:
    """
    Return frame count so spacing is at most 2 seconds.
    Uses n-1 intervals across [start, end], so n >= window/2 + 1.
    """
    cap = max_frames if max_frames is not None else max(8, int(os.getenv("FRAME_SAMPLE_MAX", "32")))
    window = max(0.1, float(window_sec))
    by_spacing = int(window / 2.0) + 1
    return max(minimum, min(cap, by_spacing))


def _dynamic_frame_minimum(video_path: str, base_minimum: int) -> int:
    """
    Increase minimum frame sampling for long landscape clips where jersey digits
    and scorebug text are harder to read.
    """
    min_frames = max(1, int(base_minimum))
    try:
        import cv2

        cap = cv2.VideoCapture(video_path)
        try:
            if not cap.isOpened():
                return min_frames
            width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
            height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
            fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
            total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        finally:
            cap.release()

        duration = (total / fps) if fps > 0 else 0.0
        is_landscape = width > height and width >= 960
        if is_landscape and duration >= 45:
            return max(min_frames, 16)
        if is_landscape and duration >= 25:
            return max(min_frames, 14)
        return min_frames
    except Exception:
        return min_frames


JerseyCacheEntry = dict[str, str]  # {"name": ..., "team": ...}


def _jersey_cache_key(j: Any, team: str) -> tuple[str, str]:
    jn = _normalize_jersey(str(j).strip()) if j is not None else None
    if not jn and j is not None:
        jn = str(j).strip().lstrip("#") or ""
    return (jn or "", (team or "").strip().lower())


def _jersey_cache_set(cache: dict[tuple[str, str], JerseyCacheEntry], j: Any, team: str, name: str, tname: str) -> None:
    key = _jersey_cache_key(j, team)
    if not key[0] or not name or name.lower() == "unknown":
        return
    cache[key] = {"name": name, "team": tname}


def _jersey_cache_get(cache: dict[tuple[str, str], JerseyCacheEntry], j: Any, team: str) -> JerseyCacheEntry | None:
    key = _jersey_cache_key(j, team)
    if not key[0]:
        return None
    hit = cache.get(key)
    if hit:
        return hit
    return cache.get((key[0], ""))


def _prior_players_flat(cache: dict[tuple[str, str], JerseyCacheEntry]) -> dict[str, JerseyCacheEntry]:
    """Vision prompt wants jersey# → {name, team}; last entry wins if same # appears for two clubs."""
    out: dict[str, JerseyCacheEntry] = {}
    for (jn, _), v in cache.items():
        if jn:
            out[jn] = v
    return out


def _continuity_from_tail_segment(seg: dict[str, Any], *, duration: float) -> str:
    """One-line summary for the next chunk’s vision prompt."""
    if not seg or duration <= 0:
        return ""
    t1 = float(seg.get("t1", 1.0))
    wall = max(0.0, min(duration, t1 * duration))
    pn = str(seg.get("player_name", "Unknown")).strip()
    tm = str(seg.get("team_name", "Unknown")).strip()
    j = seg.get("jersey_number_primary")
    jt = f"#{j}" if j not in (None, "", "unknown") else "unknown #"
    et = str(seg.get("event_type", "Other"))
    return (
        f"End of prior window (~{_fmt_time(wall)}): ball-handler {pn} ({tm}), jersey {jt}, "
        f"last labeled action: {et}."
    )


def _video_chunk_windows(
    duration: float,
    chunk_size: float,
    threshold: float,
    *,
    overlap_sec: float = 0.0,
) -> list[tuple[float, float]]:
    """Non-overlapping when overlap_sec=0; else sliding windows with overlap (re-analyze boundary)."""
    if duration <= threshold:
        return [(0.0, duration)]
    size = max(4.0, float(chunk_size))
    ov = max(0.0, float(overlap_sec))
    if ov >= size - 0.5:
        ov = max(0.0, size * 0.15)
    step = size - ov if ov > 0 else size
    step = max(1.0, step)
    out: list[tuple[float, float]] = []
    t = 0.0
    while t < duration - 0.2:
        end = min(duration, t + size)
        out.append((round(t, 4), round(end, 4)))
        if end >= duration - 0.01:
            break
        t += step
    return out


def extract_frames(
    video_path: str,
    n: int = 10,
    *,
    start_sec: float = 0.0,
    end_sec: float | None = None,
    max_width: int = 960,  # overridden below for landscape sources when higher detail helps
) -> list[bytes]:
    """Extract n evenly-spaced JPEG frames between start_sec and end_sec."""
    import cv2

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError("Could not open video (install OpenCV codecs or use MP4/H.264)")

    try:
        fps   = cap.get(cv2.CAP_PROP_FPS) or 30.0
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
        fw = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        fh = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
        if fw > fh and fw >= 1280:
            max_width = max(max_width, int(os.getenv("FRAME_MAX_WIDTH_LANDSCAPE", "1280")))
        else:
            max_width = max(max_width, int(os.getenv("FRAME_MAX_WIDTH", "960")))

        start_f = max(0, int(start_sec * fps))
        end_f   = (int(end_sec * fps) if end_sec is not None else total) - 1
        end_f   = min(end_f, total - 1)
        span    = max(1, end_f - start_f + 1)

        n = min(max(n, 1), span)
        indices = sorted({
            min(end_f, start_f + int(round(i * (span - 1) / max(n - 1, 1))))
            for i in range(n)
        })

        frames: list[bytes] = []
        for idx in indices:
            cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
            ok, frame = cap.read()
            if ok and frame is not None:
                # Resize to max_width to control token cost while preserving detail
                h, w = frame.shape[:2]
                if max_width and w > max_width:
                    scale = max_width / w
                    frame = cv2.resize(
                        frame,
                        (int(w * scale), int(h * scale)),
                        interpolation=cv2.INTER_AREA,
                    )
                _, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
                frames.append(buf.tobytes())

        if not frames:
            raise RuntimeError("No frames decoded from video")
        return frames
    finally:
        cap.release()


async def download_video(url: str) -> str:
    async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
        r = await client.get(url)
        r.raise_for_status()
        fd, path = tempfile.mkstemp(suffix=".mp4")
        os.close(fd)
        with open(path, "wb") as f:
            f.write(r.content)
        return path


def _b64_data_url(jpeg_bytes: bytes) -> str:
    b64 = base64.standard_b64encode(jpeg_bytes).decode("ascii")
    return f"data:image/jpeg;base64,{b64}"


async def vision_with_openai(
    frames: list[bytes],
    *,
    chunk_start: float = 0.0,
    chunk_end: float | None = None,
    total_duration: float | None = None,
    prior_players: dict[str, dict] | None = None,  # jersey# → {name, team} from earlier chunks
    chunk_continuity: str | None = None,  # who had ball at end of previous chunk (same game)
) -> dict[str, Any]:
    import asyncio
    from openai import AsyncOpenAI

    client    = AsyncOpenAI()
    img_detail = os.getenv("OPENAI_VISION_IMAGE_DETAIL", "high").lower()
    if img_detail not in ("low", "high", "auto"):
        img_detail = "high"   # high is required to read jersey numbers and chyrons

    nf = len(frames)
    c_dur = (chunk_end - chunk_start) if (chunk_end is not None and chunk_start is not None) else 0.0
    frame_interval = round(c_dur / max(nf - 1, 1), 2) if nf > 1 else c_dur

    # Temporal context — helps the model understand how much can change between frames
    if total_duration and total_duration > 0 and chunk_end is not None:
        time_ctx = (
            f"This clip covers {_fmt_time(chunk_start)}–{_fmt_time(chunk_end)} "
            f"of a {_fmt_time(total_duration)} video. "
            f"Frames are ~{frame_interval}s apart. "
            f"t0/t1 in segments are 0–1 relative to THIS chunk only.\n\n"
        )
    else:
        time_ctx = f"Frames are ~{frame_interval}s apart.\n\n" if frame_interval > 0 else ""

    # Build known-players context from earlier chunks
    if prior_players:
        known_lines = "\n".join(
            f"  #{j}: {v['name']} ({v['team']})"
            for j, v in sorted(prior_players.items())
        )
        known_ctx = (
            "\n=== CONFIRMED PLAYERS — NBA ROSTER VERIFIED (MANDATORY) ===\n"
            "These jersey→player mappings are confirmed against live NBA rosters.\n"
            "You MUST use these EXACT names. Do NOT substitute a different name for these jersey numbers:\n"
            + known_lines + "\n\n"
        )
    else:
        known_ctx = ""

    cont_ctx = ""
    if chunk_continuity:
        cont_ctx = (
            "\n=== CONTINUITY — SAME GAME, IMMEDIATELY AFTER THE PRIOR WINDOW ===\n"
            f"{chunk_continuity}\n"
            "The FIRST segment(s) in this chunk MUST continue that ball-handler until the video "
            "clearly shows a new possession (pass caught, rebound, steal, shot taken by someone else, etc.). "
            "Do NOT reset to a different player at t0=0 unless you see a clear change in these frames.\n\n"
        )

    system_prompt = (
        f"You are an NBA broadcast analyst. {nf} frames ~{frame_interval}s apart.\n"
        f"{time_ctx}{known_ctx}{cont_ctx}"
        "STEP 1 — READ ALL ON-SCREEN TEXT FIRST (most reliable player ID):\n"
        "• Bottom chyron/graphic: shows player name + stats when they touch the ball "
        "(e.g. 'LeBron James — 32 PTS 8 REB'). This is the BEST source.\n"
        "• Scorebug: team names, scores, clock, quarter, shot clock.\n"
        "• Replay/highlight text: player name often appears.\n"
        "• Free-throw graphic: shows shooter's name.\n\n"
        "STEP 2 — READ JERSEY NUMBERS (if chyron not visible):\n"
        "• ONLY the player TOUCHING / controlling the ball — ignore nearby defenders' numbers.\n"
        "• NEVER use shot clock, game clock, score digits, or ad text as a jersey number.\n"
        "• Wide landscape shots: zoom mentally on the ball-handler's chest/back; double-digit jerseys (e.g. 30) are common — do not drop a digit.\n"
        "• Read digits on front OR back of jersey — even partial (e.g. '2' of '#23').\n"
        "• Read name on jersey back if visible.\n"
        "• Note home vs away kit color to identify which team.\n\n"
        "STEP 3 — TRACK THE BALL:\n"
        f"• Frames are only ~{frame_interval}s apart. Any possession change you see is real.\n"
        "• Who is TOUCHING the ball = that player has it.\n"
        "• New segment when: pass caught, rebound grabbed, steal, shot taken.\n"
        "• If ball not visible, keep the previous holder.\n\n"
        "PRIORITY: chyron name > jersey back name > jersey number > Unknown.\n"
        "Never say Unknown if ANY text on screen identifies the player.\n\n"
        f'Reply ONLY valid JSON:\n{{"event_type":"one of {EVENT_TYPES}","player_name":"name or Unknown",'
        '"team_name":"team or Unknown","jersey_number_primary":"# string or null",'
        '"jersey_numbers_visible":[],"jersey_kit_description":"colors",'
        '"team_name_from_visuals":null,"team_name_from_scoreboard":null,'
        '"team_colors_description":"colors","confidence":0.9,'
        '"visual_summary":"2-3 sentences citing what you read from screen",'
        '"segments":['
        '{"t0":0.0,"t1":0.30,"event_type":"Two-Point Shot","player_name":"Player A","team_name":"Team X","jersey_number_primary":"23"},'
        '{"t0":0.30,"t1":0.65,"event_type":"Rebound","player_name":"Player B","team_name":"Team Y","jersey_number_primary":"11"},'
        '{"t0":0.65,"t1":1.0,"event_type":"Two-Point Shot","player_name":"Player C","team_name":"Team Y","jersey_number_primary":"5"}'
        '],'
        '"scoreboard":{"home_team":null,"home_score":null,"away_team":null,"away_score":null,'
        '"quarter":null,"game_clock":null,"shot_clock":null},'
        '"on_screen_text":{"game_title":null,"broadcaster":null,"player_stat_overlay":null,"other":[]}}}\n'
        "CRITICAL: segments array MUST have ONE entry per possession — create a new segment every time the ball changes hands "
        "(pass caught, rebound grabbed, steal, shot). Do NOT merge different players into one segment. "
        "t0/t1 are 0→1 fractions of THIS chunk with no gaps or overlaps."
    )

    content: list[dict[str, Any]] = [{"type": "text", "text": system_prompt}]
    for i, fb in enumerate(frames):
        t_frac = i / (nf - 1) if nf > 1 else 0.0
        wall   = chunk_start + t_frac * c_dur if c_dur > 0 else 0.0
        label  = (
            f"Frame {i+1}/{nf} — {_fmt_time(wall)} in video (~{t_frac*100:.0f}% into this chunk):"
            if total_duration else f"Frame {i+1}/{nf} (~{t_frac*100:.0f}%):"
        )
        content.append({"type": "text", "text": label})
        content.append({"type": "image_url", "image_url": {"url": _b64_data_url(fb), "detail": img_detail}})

    # Cap completion size to limit TPM; full JSON still fits typical possession timelines.
    _v_max = max(512, min(4096, int(os.getenv("OPENAI_VISION_MAX_OUTPUT_TOKENS", "2048"))))

    async def _vision_call():
        return await client.chat.completions.create(
            model=os.getenv("OPENAI_VISION_MODEL", "gpt-4o-mini"),
            messages=[{"role": "user", "content": content}],
            response_format={"type": "json_object"},
            max_tokens=_v_max,
        )

    resp = await with_openai_retry(_vision_call, label="vision")
    raw  = resp.choices[0].message.content or "{}"
    data: dict[str, Any] = json.loads(raw)

    et = data.get("event_type", "Other")
    data["event_type"]    = et if et in EVENT_TYPES else "Other"
    data["player_name"]   = str(data.get("player_name", "Unknown")).strip() or "Unknown"
    data["team_name"]     = str(data.get("team_name", "Unknown")).strip() or "Unknown"
    try:
        data["confidence"] = float(data.get("confidence", 0.5))
    except (TypeError, ValueError):
        data["confidence"] = 0.5
    data["visual_summary"] = str(data.get("visual_summary", "")).strip() or "No summary produced."

    # Parse scoreboard (tolerate type mismatches gracefully)
    raw_sb  = data.get("scoreboard") or {}
    scoreboard: dict[str, Any] = {
        "home_team":   raw_sb.get("home_team"),
        "home_score":  _safe_int(raw_sb.get("home_score")),
        "away_team":   raw_sb.get("away_team"),
        "away_score":  _safe_int(raw_sb.get("away_score")),
        "quarter":     raw_sb.get("quarter"),
        "game_clock":  raw_sb.get("game_clock"),
        "shot_clock":  _safe_int(raw_sb.get("shot_clock")),
    }
    has_scoreboard = any(v is not None for v in scoreboard.values())

    raw_ost = data.get("on_screen_text") or {}
    on_screen: dict[str, Any] = {
        "game_title":          raw_ost.get("game_title"),
        "broadcaster":         raw_ost.get("broadcaster"),
        "player_stat_overlay": raw_ost.get("player_stat_overlay"),
        "other":               [str(x) for x in (raw_ost.get("other") or []) if x],
    }
    has_on_screen = any(v for v in on_screen.values())

    valid_events = set(EVENT_TYPES)
    segments = normalize_timeline(
        data.get("segments") if isinstance(data.get("segments"), list) else [],
        data,
        valid_events,
    )

    # Pull scoreboard team names to use as jersey-resolution hints.
    # These are the most reliable team identifiers — scorebug is almost always visible.
    sb_hints: list[str] = [
        v for v in (scoreboard.get("home_team"), scoreboard.get("away_team"))
        if v and str(v).strip().lower() not in ("", "unknown", "none")
    ]

    nba_on = os.getenv("NBA_ROSTER_LOOKUP", "1").lower() not in ("0", "false", "no", "off")
    if nba_on and segments:
        await asyncio.to_thread(enrich_timeline_segments, segments, scoreboard_hints=sb_hints or None)
    if segments:
        s0 = segments[0]
        data["event_type"]  = s0["event_type"]
        data["player_name"] = s0["player_name"]
        data["team_name"]   = s0["team_name"]
        if s0.get("jersey_number_primary"):
            data["jersey_number_primary"] = s0["jersey_number_primary"]
    if nba_on:
        await asyncio.to_thread(enrich_vision_with_nba_rosters, data, extra_team_hints=sb_hints or None)

    return {
        "event_type":    data["event_type"],
        "player_name":   data["player_name"],
        "team_name":     data["team_name"],
        "confidence":    max(0.0, min(1.0, float(data["confidence"]))),
        "visual_summary": data["visual_summary"],
        "segments":      segments,
        "scoreboard":    scoreboard if has_scoreboard else None,
        "on_screen_text": on_screen if has_on_screen else None,
    }


def _safe_int(v: Any) -> int | None:
    try:
        return int(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def vision_fallback() -> dict[str, Any]:
    return {
        "event_type": "Other",
        "player_name": "Unknown",
        "team_name": "Unknown",
        "confidence": 0.15,
        "visual_summary": (
            "Vision model is not configured. Set OPENAI_API_KEY on the backend "
            "to enable frame-based event and scene understanding."
        ),
        "segments": normalize_timeline(
            [],
            {
                "event_type": "Other",
                "player_name": "Unknown",
                "team_name": "Unknown",
            },
            set(EVENT_TYPES),
        ),
    }


async def commentary_with_openai(
    structured: dict[str, Any],
    retrieved: dict[str, Any],
    temperature: float = 0.75,
) -> str:
    from openai import AsyncOpenAI

    client = AsyncOpenAI()
    # Compact JSON saves prompt tokens (same data, no indentation).
    player_blob = json.dumps(retrieved.get("player_stats") or {}, separators=(",", ":"))
    team_blob = json.dumps(retrieved.get("team_stats") or {}, separators=(",", ":"))
    prompt = f"""Write 2-4 sentences of live TV basketball commentary (energetic but factual).

Detected play:
- Event: {structured["event_type"]}
- Player (estimate): {structured["player_name"]}
- Team (estimate): {structured["team_name"]}
- Visual summary: {structured["visual_summary"]}

Retrieved stats (may be empty if unknown — do not invent numbers not listed):
Player stats JSON:
{player_blob}

Team stats JSON:
{team_blob}

Rules: If stats are empty, describe only the action. Do not fabricate specific statistics."""
    _c_max = max(120, min(1024, int(os.getenv("OPENAI_COMMENTARY_MAX_TOKENS", "300"))))

    async def _commentary_call():
        return await client.chat.completions.create(
            model=os.getenv("OPENAI_TEXT_MODEL", "gpt-4o-mini"),
            messages=[{"role": "user", "content": prompt}],
            temperature=temperature,
            max_tokens=_c_max,
        )

    resp = await with_openai_retry(_commentary_call, label="commentary")
    return (resp.choices[0].message.content or "").strip()


def commentary_template(structured: dict[str, Any], retrieved: dict[str, Any]) -> str:
    ps = retrieved.get("player_stats") or {}
    ts = retrieved.get("team_stats") or {}
    name = ps.get("name") or structured["player_name"]
    team = ts.get("name") or structured["team_name"]
    bits = [f"{structured['event_type']} on the floor."]
    if name and name != "Unknown":
        bits.append(f"{name} is involved in the play.")
    if ps.get("season_avg_ppg") is not None:
        bits.append(f"He's averaging about {ps['season_avg_ppg']} points per game this season.")
    if team and team != "Unknown" and ts.get("win_loss"):
        bits.append(f"{team} sits at {ts['win_loss']} on the year.")
    bits.append(structured["visual_summary"][:200] + ("…" if len(structured["visual_summary"]) > 200 else ""))
    return " ".join(bits)


async def supabase_get_latest(
    table: str,
    clip_id: str,
) -> dict[str, Any] | None:
    base = os.getenv("SUPABASE_URL", "").rstrip("/")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    if not base or not key:
        return None
    url = f"{base}/rest/v1/{table}"
    params = {
        "select": "*",
        "clip_id": f"eq.{clip_id}",
        "order": "created_at.desc",
        "limit": "1",
    }
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.get(url, params=params, headers=headers)
        if r.status_code != 200:
            logger.warning("Supabase %s fetch failed: %s %s", table, r.status_code, r.text)
            return None
        rows = r.json()
        return rows[0] if rows else None


def row_to_retrieved(row: dict[str, Any] | None) -> dict[str, Any]:
    if not row:
        return {"player_stats": {}, "team_stats": {}}
    return {
        "player_stats": row.get("player_stats_json") or {},
        "team_stats": row.get("team_stats_json") or {},
    }


def row_to_structured(det: dict[str, Any] | None) -> dict[str, Any] | None:
    if not det:
        return None
    return {
        "event_type": det.get("event_type") or "Other",
        "player_name": det.get("player_name") or "Unknown",
        "team_name": det.get("team_name") or "Unknown",
        "confidence": float(det.get("confidence") or 0.5),
        "visual_summary": det.get("visual_summary") or "",
    }


async def persist_to_supabase(
    clip_id: str,
    result: AnalysisResult,
    *,
    commentary_only: bool = False,
) -> None:
    """Mirror Edge Function DB writes when using direct frontend → backend mode."""
    base = os.getenv("SUPABASE_URL", "").rstrip("/")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    if not base or not key:
        return

    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    rc = result.retrieved_context
    ps = rc.get("player_stats") if rc else None
    ts = rc.get("team_stats") if rc else None

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            if not commentary_only:
                r1 = await client.post(
                    f"{base}/rest/v1/detections",
                    headers=headers,
                    json={
                        "clip_id": clip_id,
                        "event_type": result.event_type,
                        "player_name": result.player_name,
                        "team_name": result.team_name,
                        "confidence": result.confidence,
                        "visual_summary": result.visual_summary,
                    },
                )
                r1.raise_for_status()
                r2 = await client.post(
                    f"{base}/rest/v1/retrieved_context",
                    headers=headers,
                    json={
                        "clip_id": clip_id,
                        "player_stats_json": ps,
                        "team_stats_json": ts,
                    },
                )
                r2.raise_for_status()
            r3 = await client.post(
                f"{base}/rest/v1/commentaries",
                headers=headers,
                json={
                    "clip_id": clip_id,
                    "model_name": result.model_name,
                    "commentary_text": result.commentary_text,
                },
            )
            r3.raise_for_status()
    except Exception as e:
        logger.warning("Supabase persist failed (results still returned): %s", e)


async def run_analyze(clip_id: str, file_url: str, commentary_temp: float) -> AnalysisResult:
    path = await download_video(file_url)
    try:
        duration = get_video_duration(path)
        base_min_frames = int(os.getenv("FRAME_SAMPLE_COUNT", "10"))
        min_frames = _dynamic_frame_minimum(path, base_min_frames)
        n_frames = _target_frame_count(duration, minimum=min_frames)
        frames = extract_frames(path, n=n_frames)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass

    if os.getenv("OPENAI_API_KEY"):
        structured = await vision_with_openai(frames)
        vision_model = os.getenv("OPENAI_VISION_MODEL", "gpt-4o-mini")
    else:
        structured = vision_fallback()
        vision_model = "fallback-vision"

    segments: list[dict[str, Any]] = structured.get("segments") or []
    if os.getenv("OPENAI_API_KEY"):
        segment_lines = await commentary_lines_for_timeline(segments, temperature=commentary_temp)
        text = " ".join(segment_lines)
        text_model = os.getenv("OPENAI_TEXT_MODEL", "gpt-4o-mini")
        model_name = f"{vision_model}+timeline+{text_model}"
    else:
        segment_lines = template_lines_for_timeline(segments)
        text = " ".join(segment_lines)
        model_name = f"{vision_model}+timeline-template"

    structured["visual_summary"] = await visual_summary_from_timeline(
        segments,
        segment_lines,
        str(structured.get("visual_summary", "")),
    )

    retrieved = retrieve_context(structured["player_name"], structured["team_name"])
    retrieved_ctx = {
        "player_stats": retrieved["player_stats"] or None,
        "team_stats": retrieved["team_stats"] or None,
    }
    # Normalize for JSON (omit empty dicts)
    if not retrieved_ctx["player_stats"]:
        retrieved_ctx["player_stats"] = None
    if not retrieved_ctx["team_stats"]:
        retrieved_ctx["team_stats"] = None

    return AnalysisResult(
        event_type=structured["event_type"],
        player_name=structured["player_name"],
        team_name=structured["team_name"],
        confidence=max(0.0, min(1.0, structured["confidence"])),
        visual_summary=structured["visual_summary"],
        retrieved_context=retrieved_ctx if (retrieved_ctx["player_stats"] or retrieved_ctx["team_stats"]) else None,
        commentary_text=text,
        model_name=model_name,
        possession_timeline=segments,
        segment_commentary_lines=segment_lines,
    )


def _sse(event_type: str, data: dict[str, Any]) -> str:
    return f"data: {json.dumps({'type': event_type, **data})}\n\n"


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


async def _process_local_video(path: str, clip_id: str):
    """
    Core SSE generator — analyzes a local video file in time windows (see CHUNK_* env).
    Caller must delete the file after consuming the generator.
    """
    from timeline import (
        commentary_lines_for_timeline,
        template_lines_for_timeline,
        visual_summary_from_timeline,
    )

    CHUNK_THRESHOLD = float(os.getenv("CHUNK_THRESHOLD_SEC", "20"))
    CHUNK_SIZE      = float(os.getenv("CHUNK_SIZE_SEC", "15"))
    CHUNK_OVERLAP   = float(os.getenv("CHUNK_OVERLAP_SEC", "2"))

    yield _sse("status", {"step": "reading", "message": "Reading video…"})
    duration = get_video_duration(path)

    # Long videos + huge chunks → sparse coverage and lost mid-chunk events. Cap unless disabled.
    if os.getenv("CHUNK_AUTO_SHRINK", "1").lower() not in ("0", "false", "no", "off"):
        cap = float(os.getenv("CHUNK_SIZE_MAX_SEC", "18"))
        if duration > 75 and CHUNK_SIZE > cap:
            logger.info(
                "CHUNK_AUTO_SHRINK: duration=%.1fs, lowering chunk %.1fs → %.1fs for accuracy",
                duration,
                CHUNK_SIZE,
                cap,
            )
            CHUNK_SIZE = cap

    if duration <= CHUNK_THRESHOLD:
        chunks = [(0.0, duration)]
    else:
        chunks = _video_chunk_windows(
            duration,
            CHUNK_SIZE,
            CHUNK_THRESHOLD,
            overlap_sec=CHUNK_OVERLAP if CHUNK_OVERLAP > 0 else 0.0,
        )
    n_chunks = len(chunks)

    yield _sse("video_info", {"duration": round(duration, 2), "total_chunks": n_chunks})

    all_segments:     list[dict[str, Any]] = []
    all_lines:        list[str]            = []
    seen_players:     set[str]             = set()
    all_players_stats: list[dict[str, Any]] = []
    best_scoreboard:  dict[str, Any] | None = None
    best_on_screen:   dict[str, Any] | None = None
    vision_model      = "fallback"
    last_structured:  dict[str, Any] = {}
    base_min_frames = int(os.getenv("FRAME_SAMPLE_COUNT", "10"))
    min_frames = _dynamic_frame_minimum(path, base_min_frames)

    # Jersey → player cache keyed by (number, team_slug) so #5 home vs #5 away do not collide.
    jersey_cache: dict[tuple[str, str], JerseyCacheEntry] = {}

    for chunk_idx, (c_start, c_end) in enumerate(chunks):
        label  = f"{_fmt_time(c_start)}–{_fmt_time(c_end)}"
        suffix = f" (chunk {chunk_idx+1}/{n_chunks})" if n_chunks > 1 else ""

        yield _sse("status", {
            "step": "vision",
            "message": f"Analyzing {label}{suffix}…",
            "chunk_index": chunk_idx, "chunk_total": n_chunks,
            "chunk_start": c_start,   "chunk_end":   c_end,
        })

        chunk_len = max(0.1, c_end - c_start)
        chunk_frames = _target_frame_count(chunk_len, minimum=min_frames)
        frames = extract_frames(path, n=chunk_frames, start_sec=c_start, end_sec=c_end)

        cont: str | None = None
        if chunk_idx > 0 and all_segments:
            cont = _continuity_from_tail_segment(all_segments[-1], duration=duration)

        if os.getenv("OPENAI_API_KEY"):
            structured = await vision_with_openai(
                frames,
                chunk_start=c_start,
                chunk_end=c_end,
                total_duration=duration,
                prior_players=_prior_players_flat(jersey_cache) if jersey_cache else None,
                chunk_continuity=cont,
            )
            vision_model = os.getenv("OPENAI_VISION_MODEL", "gpt-4o-mini")
        else:
            structured = vision_fallback()

        last_structured = structured

        # ── jersey cache: learn from this chunk ─────────────────────────────
        for seg in (structured.get("segments") or []):
            j = seg.get("jersey_number_primary")
            nm = str(seg.get("player_name", "")).strip()
            tm = str(seg.get("team_name", "")).strip()
            if j and nm and nm.lower() not in ("unknown", ""):
                _jersey_cache_set(jersey_cache, j, tm, nm, tm)

        # Also learn from vision-level fields (sometimes more reliable)
        primary_j = structured.get("jersey_number_primary")
        primary_nm = str(structured.get("player_name", "")).strip()
        primary_tm = str(structured.get("team_name", "")).strip()
        if primary_j and primary_nm and primary_nm.lower() not in ("unknown", ""):
            _jersey_cache_set(jersey_cache, primary_j, primary_tm, primary_nm, primary_tm)

        c_dur = max(c_end - c_start, 0.001)
        global_segs: list[dict[str, Any]] = []
        trim_from = c_start + (CHUNK_OVERLAP if chunk_idx > 0 and CHUNK_OVERLAP > 0 else 0.0)
        raw_segs = structured.get("segments") or []

        def _to_global(segs: list[dict[str, Any]], *, apply_trim: bool) -> list[dict[str, Any]]:
            out: list[dict[str, Any]] = []
            for seg in segs:
                t0g = (c_start + seg["t0"] * c_dur) / duration
                t1g = (c_start + seg["t1"] * c_dur) / duration
                if apply_trim and chunk_idx > 0 and CHUNK_OVERLAP > 0:
                    wall_t0 = t0g * duration
                    if wall_t0 < trim_from - 0.05:
                        continue
                out.append({**seg, "t0": round(t0g, 6), "t1": round(t1g, 6)})
            return out

        global_segs = _to_global(raw_segs if isinstance(raw_segs, list) else [], apply_trim=True)
        if chunk_idx > 0 and CHUNK_OVERLAP > 0 and not global_segs and raw_segs:
            logger.warning(
                "Chunk %s: overlap trim removed all segments; using full chunk (possible duplicate boundary)",
                chunk_idx,
            )
            global_segs = _to_global(raw_segs, apply_trim=False)

        sb = structured.get("scoreboard")
        if sb and (sb.get("home_score") is not None or sb.get("away_score") is not None):
            best_scoreboard = sb
        elif sb and best_scoreboard is None:
            best_scoreboard = sb

        ost = structured.get("on_screen_text")
        if ost and any(ost.values()):
            if best_on_screen is None:
                best_on_screen = ost
            else:
                for k, v in ost.items():
                    if v and not best_on_screen.get(k):
                        best_on_screen[k] = v

        yield _sse("vision_chunk", {
            "chunk_index": chunk_idx, "chunk_total": n_chunks,
            "chunk_start": c_start,   "chunk_end":   c_end,
            "event_type":  structured["event_type"],
            "player_name": structured["player_name"],
            "team_name":   structured["team_name"],
            "confidence":  structured["confidence"],
            "segments":    global_segs,
            "scoreboard":  best_scoreboard,
            "on_screen_text": best_on_screen,
        })

        yield _sse("status", {
            "step": "commentary",
            "message": f"Generating commentary for {label}{suffix}…",
            "chunk_index": chunk_idx, "chunk_total": n_chunks,
        })

        # ── apply jersey cache BEFORE commentary so names are correct in text ─
        # Fixes any remaining Unknowns using names already confirmed this video.
        # Never let a segment overwrite the cache — roster-resolved names win.
        for seg in global_segs:
            j = seg.get("jersey_number_primary")
            st = str(seg.get("team_name", "") or "")
            cached = _jersey_cache_get(jersey_cache, j, st) if j else None
            if cached:
                if not seg.get("player_name") or seg["player_name"].lower() == "unknown":
                    seg["player_name"] = cached["name"]
                    seg["team_name"]   = cached["team"]

        if os.getenv("OPENAI_API_KEY") and global_segs:
            chunk_lines = await commentary_lines_for_timeline(global_segs, temperature=0.65)
        else:
            chunk_lines = template_lines_for_timeline(global_segs)

        # Retroactively patch already-emitted segments whose jersey is now resolved
        for prev_seg in all_segments[-20:]:
            pj = prev_seg.get("jersey_number_primary")
            pst = str(prev_seg.get("team_name", "") or "")
            pc = _jersey_cache_get(jersey_cache, pj, pst) if pj else None
            if pc and prev_seg.get("player_name", "").lower() == "unknown":
                prev_seg["player_name"] = pc["name"]
                prev_seg["team_name"]   = pc["team"]

        base_i = len(all_segments)
        for i, (seg, line) in enumerate(zip(global_segs, chunk_lines)):
            yield _sse("segment", {"index": base_i + i, "line": line, "segment": seg})

        all_segments.extend(global_segs)
        all_lines.extend(chunk_lines)

        for seg in global_segs:
            name = str(seg.get("player_name", "")).strip()
            if name and name.lower() != "unknown" and name not in seen_players:
                seen_players.add(name)
                ctx = retrieve_context(name, str(seg.get("team_name", "")))
                all_players_stats.append({
                    "player_name":   name,
                    "team_name":     str(seg.get("team_name", "")),
                    "jersey_number": seg.get("jersey_number_primary"),
                    "player_stats":  ctx.get("player_stats") or {},
                    "team_stats":    ctx.get("team_stats")   or {},
                })

    # Final cleanup: use the full jersey_cache + best scoreboard to resolve any
    # Unknown players that slipped through per-chunk enrichment (e.g. first chunk
    # had no scoreboard yet but a later chunk identified the teams).
    sb_final_hints: list[str] = [
        v for v in (
            (best_scoreboard or {}).get("home_team"),
            (best_scoreboard or {}).get("away_team"),
        )
        if v and str(v).strip().lower() not in ("", "unknown", "none")
    ]
    nba_on_final = os.getenv("NBA_ROSTER_LOOKUP", "1").lower() not in ("0", "false", "no", "off")
    if nba_on_final:
        import asyncio as _asyncio
        await _asyncio.to_thread(
            enrich_timeline_segments,
            [s for s in all_segments if s.get("player_name", "").lower() == "unknown"],
            scoreboard_hints=sb_final_hints or None,
        )
    for seg in all_segments:
        j = seg.get("jersey_number_primary")
        st = str(seg.get("team_name", "") or "")
        hit = _jersey_cache_get(jersey_cache, j, st) if j else None
        if hit and seg.get("player_name", "").lower() == "unknown":
            seg["player_name"] = hit["name"]
            seg["team_name"]   = hit["team"]

    sample_segs  = (all_segments[:3] + all_segments[-3:]) if len(all_segments) > 6 else all_segments
    sample_lines = (all_lines[:3]    + all_lines[-3:])    if len(all_lines)    > 6 else all_lines
    visual_summary = await visual_summary_from_timeline(
        sample_segs, sample_lines, last_structured.get("visual_summary", "")
    )

    text_model = os.getenv("OPENAI_TEXT_MODEL", "gpt-4o-mini")
    primary    = all_players_stats[0] if all_players_stats else {}
    rc         = {"player_stats": primary.get("player_stats") or None,
                  "team_stats":   primary.get("team_stats")   or None}
    first_seg  = all_segments[0] if all_segments else {}

    full_result = AnalysisResult(
        event_type         = first_seg.get("event_type", "Other"),
        player_name        = first_seg.get("player_name", "Unknown"),
        team_name          = first_seg.get("team_name",  "Unknown"),
        confidence         = max(0.0, min(1.0, last_structured.get("confidence", 0.5))),
        visual_summary     = visual_summary,
        retrieved_context  = rc if (rc["player_stats"] or rc["team_stats"]) else None,
        commentary_text    = " ".join(all_lines),
        model_name         = f"{vision_model}+stream+{text_model}+{n_chunks}ch",
        possession_timeline        = all_segments,
        segment_commentary_lines   = all_lines,
    )
    # Only persist to Supabase when we have a real clip UUID (not the direct-upload path)
    if clip_id and clip_id not in ("local", ""):
        await persist_to_supabase(clip_id, full_result, commentary_only=False)

    yield _sse("complete", {
        "commentary_text":          full_result.commentary_text,
        "segment_commentary_lines": all_lines,
        "possession_timeline":      all_segments,
        "visual_summary":           visual_summary,
        "players_stats":            all_players_stats,
        "scoreboard":               best_scoreboard,
        "on_screen_text":           best_on_screen,
        "model_name":               full_result.model_name,
        "duration":                 round(duration, 2),
        "chunks_processed":         n_chunks,
    })


_SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"}


@app.post("/analyze-stream")
async def analyze_stream(body: ClipRequest) -> StreamingResponse:
    """SSE: download video from URL, then process in chunks."""
    async def generate():
        path: str | None = None
        try:
            yield _sse("status", {"step": "downloading", "message": "Downloading video…"})
            path = await download_video(body.file_url)
            async for event in _process_local_video(path, body.clip_id):
                yield event
        except Exception as exc:
            logger.exception("analyze-stream failed")
            yield _sse("error", {"message": str(exc)})
        finally:
            if path:
                try: os.remove(path)
                except OSError: pass

    return StreamingResponse(generate(), media_type="text/event-stream", headers=_SSE_HEADERS)


@app.post("/upload-analyze-stream")
async def upload_analyze_stream(
    request: Request,
    clip_id: str = Query(default="local"),
) -> StreamingResponse:
    """
    SSE: receive a raw video body and analyze it — no python-multipart needed,
    no Supabase storage, no file-size limits.
    Frontend sends: POST /upload-analyze-stream?clip_id=local  with body = raw file bytes.
    """
    fd, saved_path = tempfile.mkstemp(suffix=".mp4")
    os.close(fd)
    try:
        # Stream body straight to disk — never buffers the whole file in RAM
        with open(saved_path, "wb") as f:
            async for chunk in request.stream():
                f.write(chunk)
    except Exception as e:
        try: os.remove(saved_path)
        except OSError: pass
        raise HTTPException(status_code=500, detail=f"Failed to save video: {e}") from e

    async def generate():
        try:
            async for event in _process_local_video(saved_path, clip_id):
                yield event
        except Exception as exc:
            logger.exception("upload-analyze-stream failed")
            yield _sse("error", {"message": str(exc)})
        finally:
            try: os.remove(saved_path)
            except OSError: pass

    return StreamingResponse(generate(), media_type="text/event-stream", headers=_SSE_HEADERS)


class FrameRequest(BaseModel):
    frame_data: str          # base64-encoded JPEG from the browser canvas
    timestamp: float = 0.0   # current video time in seconds
    duration: float  = 0.0   # total video duration
    prev_player: str | None = None   # previous ball-handler for continuity
    prev_jersey: str | None = None
    prev_team:   str | None = None
    prev_confidence: float | None = None
    prev_event: str | None = None
    prev_ball_state: str | None = None


def _is_unknown_name(value: str | None) -> bool:
    return not value or str(value).strip().lower() in {"", "unknown", "none", "n/a"}


def _normalize_jersey(value: str | None) -> str | None:
    if not value:
        return None
    cleaned = str(value).strip().lstrip("#").strip()
    if not cleaned:
        return None
    # Keep compact alnum token, but prefer numeric jersey content.
    digits = "".join(ch for ch in cleaned if ch.isdigit())
    return digits or cleaned


class PlayerStatsRequest(BaseModel):
    player_name: str
    team_name:   str = ""


async def _quick_frame_analysis(body: FrameRequest) -> dict[str, Any]:
    """Analyze a single browser-captured frame: who has the ball right now?"""
    from openai import AsyncOpenAI
    import asyncio

    client     = AsyncOpenAI()
    img_bytes  = base64.b64decode(body.frame_data)
    img_b64    = base64.standard_b64encode(img_bytes).decode("ascii")
    time_str   = f"{int(body.timestamp // 60)}:{int(body.timestamp % 60):02d}"

    # Context from previous frame so model doesn't lose the ball unnecessarily
    ctx = ""
    if body.prev_player and body.prev_player.lower() not in ("", "unknown"):
        jersey_hint = f" (#{body.prev_jersey})" if body.prev_jersey else ""
        ctx = (
            f"\nCONTEXT: In the previous frame, {body.prev_player}{jersey_hint} "
            f"of {body.prev_team or 'Unknown'} had the ball. "
            "Only change ball-handler if you clearly see possession transfer in THIS frame."
        )

    prompt = (
        f"NBA broadcast frame at {time_str}.{ctx}\n\n"
        "WHO HAS THE BALL RIGHT NOW?\n"
        "- Dribbling → that player\n"
        "- Just shot → shooter\n"
        "- Pass in air → passer\n"
        "- Catching → receiver\n"
        "- Loose on floor or no clear handler → player_name='Unknown'\n\n"
        "IMPORTANT:\n"
        "- If you can clearly see a NEW player with control, switch directly to that player.\n"
        "- Do not keep prior holder when visual evidence shows transfer.\n"
        "- If no player clearly controls the ball, mark Unknown and set ball_state accordingly.\n\n"
        "Read jersey ONLY on the ball-handler's uniform (not other players). Never use shot/game clock digits as a jersey.\n"
        "On wide shots, read both digits of two-digit numbers (e.g. 30 not 3 or 5).\n"
        "Read scorebug if visible.\n\n"
        "JSON only:\n"
        '{"player_name":"Name or Unknown","jersey_number":"# or null","team_name":"team or Unknown",'
        f'"event_type":"one of {EVENT_TYPES}","confidence":0.0-1.0,'
        '"ball_state":"in_hand|in_air|loose_on_floor|out_of_frame",'
        '"commentary":"max 10 words broadcast style",'
        '"scoreboard":{"home_team":null,"home_score":null,"away_team":null,"away_score":null,"quarter":null,"game_clock":null,"shot_clock":null},'
        '"on_screen_text":{"game_title":null,"broadcaster":null,"player_stat_overlay":null,"other":[]}}'
    )

    _f_max = max(64, min(256, int(os.getenv("OPENAI_FRAME_MAX_OUTPUT_TOKENS", "100"))))

    async def _call():
        return await client.chat.completions.create(
            model=os.getenv("OPENAI_VISION_MODEL", "gpt-4o-mini"),
            messages=[{"role": "user", "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {
                    "url": f"data:image/jpeg;base64,{img_b64}",
                    "detail": os.getenv("LIVE_FRAME_IMAGE_DETAIL", "auto"),
                }},
            ]}],
            response_format={"type": "json_object"},
            max_tokens=_f_max,
        )

    resp = await with_openai_retry(_call, label="frame_analysis")
    raw  = resp.choices[0].message.content or "{}"
    data: dict[str, Any] = json.loads(raw)

    player  = str(data.get("player_name", "Unknown")).strip() or "Unknown"
    jersey  = _normalize_jersey(str(data.get("jersey_number") or "").strip() or None)
    team    = str(data.get("team_name", "Unknown")).strip() or "Unknown"
    event   = data.get("event_type", "Other")
    if event not in EVENT_TYPES:
        event = "Other"
    try:
        conf = float(data.get("confidence", 0.5))
    except (TypeError, ValueError):
        conf = 0.5

    # Stabilize live playback tracking:
    # if this frame is uncertain/Unknown, preserve previous holder when available.
    prev_player = (body.prev_player or "").strip()
    prev_team = (body.prev_team or "").strip()
    prev_jersey = _normalize_jersey((body.prev_jersey or "").strip() or None)
    prev_conf = float(body.prev_confidence) if body.prev_confidence is not None else None
    prev_event = (body.prev_event or "").strip()
    prev_ball_state = (body.prev_ball_state or "").strip()
    ball_state = str(data.get("ball_state", "in_hand")).strip() or "in_hand"
    uncertain_holder = _is_unknown_name(player) or conf < 0.45

    # Confidence gate for live switching:
    # require stronger evidence to replace a known holder unless event/ball-state implies a clear transfer.
    transfer_event = event in {"Assist", "Rebound", "Turnover", "Block", "Layup or Dunk", "Two-Point Shot", "Three-Point Shot"}
    transfer_ball_state = ball_state in {"in_air", "loose_on_floor"}
    has_prev_holder = not _is_unknown_name(prev_player)
    switched_holder = has_prev_holder and not _is_unknown_name(player) and player.lower() != prev_player.lower()
    strong_switch = conf >= 0.62 or transfer_event or transfer_ball_state

    if switched_holder and not strong_switch:
        player = prev_player
        team = prev_team or team
        jersey = prev_jersey or jersey
        conf = max(conf, prev_conf or 0.5)
        event = prev_event or event
        ball_state = prev_ball_state or ball_state

    if uncertain_holder and not _is_unknown_name(prev_player):
        player = prev_player
        team = prev_team or team
        jersey = prev_jersey or jersey
        conf = max(conf, prev_conf or 0.46)

    # Run roster lookup synchronously so the response already has the correct name.
    # Roster is cached per team for 45 min so only the first call per team is slow.
    nba_on = os.getenv("NBA_ROSTER_LOOKUP", "1").lower() not in ("0", "false", "no", "off")
    if nba_on and jersey and team.lower() != "unknown":
        raw_sb = data.get("scoreboard") or {}
        sb_team_hint = raw_sb.get("home_team") or raw_sb.get("away_team")
        work = {
            "player_name": player,
            "team_name":   team,
            "jersey_number_primary":    jersey,
            "team_name_from_visuals":   team,
            "team_name_from_scoreboard": sb_team_hint,
            "confidence":   conf,
            "visual_summary": "",
        }
        import asyncio as _asyncio
        await _asyncio.to_thread(enrich_vision_with_nba_rosters, work)
        player = work["player_name"]
        team   = work["team_name"]
        conf   = work.get("confidence", conf)

    raw_sb = data.get("scoreboard") or {}
    scoreboard = {
        "home_team":  raw_sb.get("home_team"),
        "home_score": _safe_int(raw_sb.get("home_score")),
        "away_team":  raw_sb.get("away_team"),
        "away_score": _safe_int(raw_sb.get("away_score")),
        "quarter":    raw_sb.get("quarter"),
        "game_clock": raw_sb.get("game_clock"),
        "shot_clock": _safe_int(raw_sb.get("shot_clock")),
    }
    has_sb = any(v is not None for v in scoreboard.values())

    raw_ost = data.get("on_screen_text") or {}
    on_screen = {
        "game_title":          raw_ost.get("game_title"),
        "broadcaster":         raw_ost.get("broadcaster"),
        "player_stat_overlay": raw_ost.get("player_stat_overlay"),
        "other":               [str(x) for x in (raw_ost.get("other") or []) if x],
    }
    has_ost = any(v for v in on_screen.values())

    return {
        "player_name":  player,
        "jersey_number": jersey,
        "team_name":    team,
        "event_type":   event,
        "ball_state":   ball_state,
        "confidence":   round(max(0.0, min(1.0, conf)), 3),
        "commentary":   str(data.get("commentary", "")).strip(),
        "scoreboard":   scoreboard if has_sb  else None,
        "on_screen_text": on_screen if has_ost else None,
        "timestamp":    body.timestamp,
    }


def _frame_rate_limited_fallback(body: FrameRequest) -> dict[str, Any]:
    """Return a stable fallback response when frame analysis is rate-limited."""
    fallback_player = (body.prev_player or "").strip() or "Unknown"
    fallback_team = (body.prev_team or "").strip() or "Unknown"
    fallback_event = (body.prev_event or "").strip() or "Other"
    fallback_state = (body.prev_ball_state or "").strip() or "out_of_frame"
    conf = body.prev_confidence if body.prev_confidence is not None else 0.3
    try:
        conf = float(conf)
    except (TypeError, ValueError):
        conf = 0.3
    return {
        "player_name": fallback_player,
        "jersey_number": _normalize_jersey(body.prev_jersey),
        "team_name": fallback_team,
        "event_type": fallback_event if fallback_event in EVENT_TYPES else "Other",
        "ball_state": fallback_state,
        "confidence": round(max(0.0, min(1.0, conf)), 3),
        "commentary": "Rate-limited; using previous holder.",
        "scoreboard": None,
        "on_screen_text": None,
        "timestamp": body.timestamp,
        "rate_limited": True,
    }


@app.post("/analyze-frame")
async def analyze_frame(body: FrameRequest) -> dict[str, Any]:
    """Real-time single-frame analysis: who has the ball right now?"""
    if not os.getenv("OPENAI_API_KEY"):
        raise HTTPException(status_code=503, detail="OPENAI_API_KEY not set on backend")
    try:
        return await _quick_frame_analysis(body)
    except Exception as e:
        msg = str(e)
        if "rate limit" in msg.lower() or "rate_limit_exceeded" in msg.lower():
            return _frame_rate_limited_fallback(body)
        logger.exception("analyze-frame failed")
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.post("/player-stats")
async def player_stats_endpoint(body: PlayerStatsRequest) -> dict[str, Any]:
    """Look up stats for a named player from the knowledge base."""
    ctx = retrieve_context(body.player_name, body.team_name)
    return {
        "player_stats": ctx.get("player_stats") or {},
        "team_stats":   ctx.get("team_stats")   or {},
    }


@app.post("/export-commentary-video")
async def export_commentary_video(body: VoiceoverExportBody) -> FileResponse:
    """TTS (OpenAI) + FFmpeg: one MP4 with AI voiceover replacing the clip audio."""
    if not os.getenv("OPENAI_API_KEY"):
        raise HTTPException(
            status_code=503,
            detail="OPENAI_API_KEY is required to synthesize voiceover audio.",
        )
    try:
        tl = body.possession_timeline
        sl = body.segment_commentary_lines
        if (
            tl
            and sl
            and len(tl) == len(sl)
            and len(tl) > 0
        ):
            out_path = await build_voiceover_timeline_mp4(body.file_url, tl, sl)
        else:
            out_path = await build_voiceover_mp4(
                body.file_url, (body.commentary_text or "").strip() or "No commentary."
            )
    except Exception as e:
        logger.exception("Voiceover export failed")
        raise HTTPException(status_code=500, detail=str(e)) from e
    return FileResponse(
        out_path,
        media_type="video/mp4",
        filename="vision2voice-voiceover.mp4",
        background=BackgroundTask(_unlink_temp, out_path),
    )


@app.post("/analyze", response_model=AnalysisResult)
async def analyze(body: ClipRequest) -> AnalysisResult:
    try:
        result = await run_analyze(body.clip_id, body.file_url, commentary_temp=0.75)
        await persist_to_supabase(body.clip_id, result, commentary_only=False)
        return result
    except httpx.HTTPStatusError as e:
        logger.exception("Download failed")
        raise HTTPException(status_code=502, detail=f"Video download failed: {e}") from e
    except Exception as e:
        logger.exception("Analyze failed")
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.post("/regenerate", response_model=AnalysisResult)
async def regenerate(body: ClipRequest) -> AnalysisResult:
    det = await supabase_get_latest("detections", body.clip_id)
    ctx_row = await supabase_get_latest("retrieved_context", body.clip_id)
    structured = row_to_structured(det)

    if structured and structured.get("visual_summary"):
        retrieved = row_to_retrieved(ctx_row)
        if not retrieved["player_stats"] and not retrieved["team_stats"]:
            retrieved = retrieve_context(structured["player_name"], structured["team_name"])
        if os.getenv("OPENAI_API_KEY"):
            text = await commentary_with_openai(structured, retrieved, temperature=0.95)
            model_name = f"{os.getenv('OPENAI_TEXT_MODEL', 'gpt-4o-mini')}-regen"
        else:
            text = commentary_template(structured, retrieved)
            model_name = "template-regen"
        rc = {
            "player_stats": retrieved["player_stats"] or None,
            "team_stats": retrieved["team_stats"] or None,
        }
        if not rc["player_stats"]:
            rc["player_stats"] = None
        if not rc["team_stats"]:
            rc["team_stats"] = None
        result = AnalysisResult(
            event_type=structured["event_type"],
            player_name=structured["player_name"],
            team_name=structured["team_name"],
            confidence=structured["confidence"],
            visual_summary=structured["visual_summary"],
            retrieved_context=rc if (rc["player_stats"] or rc["team_stats"]) else None,
            commentary_text=text,
            model_name=model_name,
            possession_timeline=[],
            segment_commentary_lines=[],
        )
        await persist_to_supabase(body.clip_id, result, commentary_only=True)
        return result

    result = await run_analyze(body.clip_id, body.file_url, commentary_temp=0.95)
    await persist_to_supabase(body.clip_id, result, commentary_only=False)
    return result
