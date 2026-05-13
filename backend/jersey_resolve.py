"""
Map jersey numbers + team hints to NBA player names using nba_api (stats.nba.com data).
"""

from __future__ import annotations

import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

logger = logging.getLogger("vision2voice.jersey")

_ROSTER_CACHE: dict[int, list[tuple[str, str]]] = {}
_CACHE_LOCK = threading.Lock()
_CACHE_TTL_SEC = 45 * 60
_CACHE_TIME: dict[int, float] = {}

# jersey-key → resolved player name (None = confirmed not found anywhere).
# Avoids re-querying the same number across segments / chunks.
_JERSEY_RESOLUTION_CACHE: dict[str, str | None] = {}
_JERSEY_TEAM_CACHE: dict[str, str] = {}
_JERSEY_RES_LOCK = threading.Lock()


def _jersey_key(num: str) -> str:
    s = str(num).strip()
    if not s:
        return ""
    if s.isdigit():
        if s == "00":
            return "00"
        return str(int(s))
    return s


def _jersey_match(roster_num: str, target: str) -> bool:
    return _jersey_key(roster_num) == _jersey_key(target)


_NBA_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.nba.com/",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://www.nba.com",
}

_NBA_TIMEOUT = int(os.getenv("NBA_API_TIMEOUT", "60"))
_FULL_SCAN_WORKERS = int(os.getenv("NBA_FULL_SCAN_WORKERS", "10"))


def _fetch_roster(team_id: int) -> list[tuple[str, str]]:
    from nba_api.stats.endpoints import commonteamroster

    try:
        r = commonteamroster.CommonTeamRoster(
            team_id=team_id,
            timeout=_NBA_TIMEOUT,
            headers=_NBA_HEADERS,
        )
        df = r.get_data_frames()[0]
    except Exception as exc:
        logger.warning("Roster fetch failed for team %s (skipping): %s", team_id, exc)
        return []
    out: list[tuple[str, str]] = []
    for _, row in df.iterrows():
        name = str(row.get("PLAYER", "")).strip()
        num = str(row.get("NUM", "")).strip()
        if name and num and num != "None":
            out.append((name, num))
    return out


def get_roster(team_id: int) -> list[tuple[str, str]]:
    now = time.monotonic()
    with _CACHE_LOCK:
        ts = _CACHE_TIME.get(team_id, 0)
        if team_id in _ROSTER_CACHE and (now - ts) < _CACHE_TTL_SEC:
            return _ROSTER_CACHE[team_id]
    roster = _fetch_roster(team_id)
    with _CACHE_LOCK:
        _ROSTER_CACHE[team_id] = roster
        _CACHE_TIME[team_id] = time.monotonic()
    return roster


def _nba_team_list() -> list[dict[str, Any]]:
    from nba_api.stats.static import teams as nba_teams

    return nba_teams.get_teams()


def _score_team_hint(blob: str, t: dict[str, Any]) -> int:
    b = blob.lower().strip()
    if len(b) < 2:
        return 0
    full = (t.get("full_name") or "").lower()
    nick = (t.get("nickname") or "").lower()
    city = (t.get("city") or "").lower()
    abbr = (t.get("abbreviation") or "").lower()
    if b == abbr:
        return 100
    if nick and (b == nick or nick in b or b in nick):
        return 92
    if nick and nick in b:
        return 88
    if b in full and nick and nick in b:
        return 86
    if b in full and len(b) >= 14:
        return 78
    if full in b and len(full) >= 10:
        return 76
    if b in full or full in b:
        return 58
    if city in b or b in city:
        if city == "los angeles" and b.strip() in ("los angeles", "la", "l.a.", "l a"):
            return 8
        return 22
    return 0


def team_ids_from_hints(*hints: str) -> list[int]:
    """Fuzzy match vision strings to NBA team ids; best matches first."""
    blobs = [h.lower().strip() for h in hints if h and str(h).strip().lower() not in ("", "unknown")]
    if not blobs:
        return []
    min_score = int(os.getenv("NBA_TEAM_HINT_MIN_SCORE", "35"))
    scored: list[tuple[int, int]] = []
    seen: set[int] = set()
    for t in _nba_team_list():
        tid = int(t["id"])
        if tid in seen:
            continue
        best = 0
        for blob in blobs:
            best = max(best, _score_team_hint(blob, t))
        if best >= min_score:
            seen.add(tid)
            scored.append((best, tid))
    scored.sort(key=lambda x: (-x[0], x[1]))
    return [tid for _, tid in scored[:8]]


def resolve_player_from_roster(jersey: str, team_id: int) -> str | None:
    j = _jersey_key(jersey)
    if not j:
        return None
    for name, num in get_roster(team_id):
        if _jersey_match(num, j):
            return name
    return None


def prewarm_rosters(team_hints: list[str]) -> None:
    """Fetch rosters for the hinted teams in parallel so they're cached before enrichment."""
    tids = team_ids_from_hints(*team_hints)
    if not tids:
        return
    now = time.monotonic()
    uncached = []
    with _CACHE_LOCK:
        for tid in tids:
            ts = _CACHE_TIME.get(tid, 0)
            if tid not in _ROSTER_CACHE or (now - ts) >= _CACHE_TTL_SEC:
                uncached.append(tid)
    if not uncached:
        return
    with ThreadPoolExecutor(max_workers=min(len(uncached), _FULL_SCAN_WORKERS)) as pool:
        futures = {pool.submit(get_roster, tid): tid for tid in uncached}
        for f in as_completed(futures):
            try:
                f.result()
            except Exception as exc:
                logger.warning("Prewarm failed for team %s: %s", futures[f], exc)


def _vision_named_player_specific(name: str) -> bool:
    """True when vision gave a probable full name (not 'Unknown' / one token)."""
    n = (name or "").strip()
    if not n or n.lower() == "unknown":
        return False
    parts = [p for p in n.replace(".", " ").split() if len(p) >= 2]
    return len(parts) >= 2


def _roster_player_matches_vision(vision_name: str, roster_full_name: str) -> bool:
    """Fuzzy match vision name to NBA roster PLAYER string (e.g. 'S. Curry' vs 'Stephen Curry')."""
    v = [p for p in _normalize_person_name(vision_name).split() if len(p) >= 2]
    r = [p for p in _normalize_person_name(roster_full_name).split() if len(p) >= 2]
    if not v or not r:
        return False
    if v[-1] != r[-1]:
        return False
    if len(v) >= 2 and len(r) >= 2:
        return v[0][0] == r[0][0] or v[0] == r[0]
    return True


def lookup_jersey_for_player_on_teams(player_name: str, team_ids: list[int]) -> tuple[str | None, int | None]:
    """Return (jersey digits, team_id) for the roster row that matches player_name."""
    pn = (player_name or "").strip()
    if not _vision_named_player_specific(pn):
        return None, None
    for tid in team_ids:
        for roster_name, num in get_roster(tid):
            if not roster_name or not num:
                continue
            if _roster_player_matches_vision(pn, roster_name):
                return _jersey_key(num), tid
    return None, None


def align_jersey_to_named_player(
    vision: dict[str, Any],
    team_hints: list[str],
    extra_team_hints: list[str] | None = None,
) -> None:
    """
    When vision has a trustworthy player name, prefer NBA roster jersey for that player.
    Fixes common landscape misreads (e.g. #30 read as #5 from another defender or graphics).
    Mutates vision in place.
    """
    name = str(vision.get("player_name", "")).strip()
    if not _vision_named_player_specific(name) or name.lower() == "unknown":
        return
    hints = [h for h in (team_hints + list(extra_team_hints or [])) if h and str(h).strip().lower() not in ("", "unknown")]
    team_ids = team_ids_from_hints(*hints)
    if not team_ids:
        return
    true_j, _tid = lookup_jersey_for_player_on_teams(name, team_ids)
    if not true_j:
        return
    raw = (
        vision.get("jersey_number_primary")
        or vision.get("jersey_number")
        or (vision.get("jersey_numbers_visible") or [None])[0]
    )
    cur = _jersey_key(str(raw)) if raw not in (None, "") else ""
    if not cur or cur != true_j:
        logger.info(
            "Jersey align from name: %r roster #%s (vision had #%s)",
            name,
            true_j,
            cur or "—",
        )
    vision["jersey_number_primary"] = true_j


def _normalize_person_name(name: str) -> str:
    return " ".join((name or "").lower().split())


def _hint_aligns_with_resolved_team(hints: list[str], nba_full_name: str) -> bool:
    """True if any non-unknown hint is consistent with the NBA full team name."""
    nf = (nba_full_name or "").lower().strip()
    if not nf:
        return False
    for raw in hints:
        h = raw.lower().strip()
        if len(h) < 3 or h == "unknown":
            continue
        if h in nf or nf in h:
            return True
        if "laker" in h and "laker" in nf:
            return True
        if "clip" in h and "clip" in nf:
            return True
        for tok in nf.split():
            if len(tok) >= 4 and tok in h:
                return True
    return False


def _resolve_jersey_uncached(
    jersey: str,
    team_ids: list[int],
) -> tuple[str | None, int | None]:
    """Try hinted teams first, then parallel full-scan. Returns (player, team_id)."""
    for tid in team_ids:
        name = resolve_player_from_roster(jersey, tid)
        if name:
            return name, tid

    already_tried = set(team_ids)
    all_tids = [int(t["id"]) for t in _nba_team_list() if int(t["id"]) not in already_tried]
    if not all_tids:
        return None, None

    matches: list[tuple[str, int]] = []
    with ThreadPoolExecutor(max_workers=min(len(all_tids), _FULL_SCAN_WORKERS)) as pool:
        future_to_tid = {pool.submit(resolve_player_from_roster, jersey, tid): tid for tid in all_tids}
        for future in as_completed(future_to_tid):
            tid = future_to_tid[future]
            try:
                name = future.result()
                if name:
                    matches.append((name, tid))
            except Exception as exc:
                logger.debug("Roster lookup error for team %s: %s", tid, exc)

    if len(matches) == 1:
        player, tid = matches[0]
        logger.info("Full-scan resolved jersey #%s → %s (unique league-wide)", jersey, player)
        return player, tid
    if len(matches) > 1:
        logger.debug("Jersey #%s ambiguous across %d teams — skipping", jersey, len(matches))
    return None, None


def enrich_vision_with_nba_rosters(
    vision: dict[str, Any],
    *,
    append_match_note: bool = True,
    extra_team_hints: list[str] | None = None,
) -> dict[str, Any]:
    """
    Resolve jersey # → player name via current NBA rosters.
    Mutates and returns the same dict. Uses a process-level jersey cache so the
    same number is never re-fetched across segments/chunks.
    """
    team_hints = [
        str(vision.get("team_name", "") or ""),
        str(vision.get("team_name_from_visuals", "") or ""),
        str(vision.get("team_name_from_scoreboard", "") or ""),
        *(extra_team_hints or []),
    ]
    team_ids = team_ids_from_hints(*team_hints)

    # Prefer roster jersey when we already trust the on-screen / model player name
    # (stops #30 → misread as #5 from a nearby defender or scorebug digit).
    align_jersey_to_named_player(vision, team_hints, extra_team_hints)

    jersey = (
        vision.get("jersey_number_primary")
        or vision.get("primary_jersey_number")
        or (vision.get("jersey_numbers_visible") or [None])[0]
    )
    jersey = str(jersey).strip() if jersey is not None else ""
    if not jersey or jersey.lower() == "unknown":
        return vision

    jkey = _jersey_key(jersey)
    tid_key = ",".join(str(t) for t in sorted(set(team_ids))[:8]) if team_ids else ""
    cache_key = f"{jkey}|{tid_key}" if tid_key else jkey

    # Fast path: already resolved this jersey+teams in this process run
    with _JERSEY_RES_LOCK:
        if cache_key in _JERSEY_RESOLUTION_CACHE:
            resolved_player = _JERSEY_RESOLUTION_CACHE[cache_key]
            resolved_tname = _JERSEY_TEAM_CACHE.get(cache_key)
            if resolved_player and resolved_tname:
                _apply_roster_result(vision, jersey, resolved_player, resolved_tname, team_hints, append_match_note)
            return vision

    resolved_player, resolved_team_id = _resolve_jersey_uncached(jersey, team_ids)

    tname: str | None = None
    if resolved_player and resolved_team_id is not None:
        tinfo = next((t for t in _nba_team_list() if t["id"] == resolved_team_id), None)
        tname = (tinfo or {}).get("full_name") or "Unknown"

    with _JERSEY_RES_LOCK:
        _JERSEY_RESOLUTION_CACHE[cache_key] = resolved_player
        if tname:
            _JERSEY_TEAM_CACHE[cache_key] = tname

    if resolved_player and tname:
        if any(str(h).strip() and str(h).strip().lower() != "unknown" for h in team_hints):
            if not _hint_aligns_with_resolved_team(team_hints, tname):
                logger.info(
                    "Skipping roster match: resolved team %r does not match hints %r",
                    tname,
                    team_hints,
                )
                return vision
        _apply_roster_result(vision, jersey, resolved_player, tname, team_hints, append_match_note)
    elif not resolved_player and team_ids:
        logger.debug("Jersey %s not resolved from team hints %s", jersey, team_ids)

    return vision


def _apply_roster_result(
    vision: dict[str, Any],
    jersey: str,
    resolved_player: str,
    tname: str,
    team_hints: list[str],
    append_match_note: bool,
) -> None:
    old_p = str(vision.get("player_name", "")).strip()
    if _vision_named_player_specific(old_p) and not _roster_player_matches_vision(old_p, resolved_player):
        logger.info(
            "Skipping roster name swap: vision %r but jersey #%s maps to %r — trust vision name (jersey misread)",
            old_p,
            jersey,
            resolved_player,
        )
        return
    if _vision_named_player_specific(old_p) and _normalize_person_name(old_p) != _normalize_person_name(resolved_player):
        logger.info(
            "Roster override: vision said %r → roster resolves #%s as %r (%s)",
            old_p,
            jersey,
            resolved_player,
            tname,
        )
    vision["player_name"] = resolved_player
    vision["team_name"] = tname
    if append_match_note:
        note = (
            f" Roster match (jersey #{jersey}, NBA stats): {resolved_player} ({tname})."
            f" Prior model guess was: {old_p}."
        )
        vision["visual_summary"] = (vision.get("visual_summary") or "").strip() + note
    try:
        vision["confidence"] = min(0.98, float(vision.get("confidence", 0.6)) + 0.12)
    except (TypeError, ValueError):
        vision["confidence"] = 0.85
    logger.info("Resolved jersey #%s -> %s (%s)", jersey, resolved_player, tname)


def enrich_timeline_segments(
    segments: list[dict[str, Any]],
    *,
    scoreboard_hints: list[str] | None = None,
) -> None:
    """Resolve jersey # → player for each possession segment.
    Pre-warms rosters for hinted teams in parallel before looping segments.
    """
    if not segments:
        return

    # Collect all team hints up-front and prewarm their rosters in parallel.
    all_hints: list[str] = list(scoreboard_hints or [])
    for seg in segments:
        for key in ("team_name", "team_name_from_visuals", "team_name_from_scoreboard"):
            v = str(seg.get(key) or "").strip()
            if v and v.lower() != "unknown":
                all_hints.append(v)
    if all_hints:
        prewarm_rosters(all_hints)

    for seg in segments:
        work = {
            "player_name": str(seg.get("player_name", "Unknown")),
            "team_name": str(seg.get("team_name", "Unknown")),
            "jersey_number_primary": seg.get("jersey_number_primary") or seg.get("jersey_number"),
            "team_name_from_visuals": seg.get("team_name_from_visuals") or seg.get("team_name"),
            "team_name_from_scoreboard": seg.get("team_name_from_scoreboard"),
            "confidence": float(seg.get("confidence", 0.5) or 0.5),
            "visual_summary": "",
        }
        enrich_vision_with_nba_rosters(work, append_match_note=False, extra_team_hints=scoreboard_hints or [])
        seg["player_name"] = work["player_name"]
        seg["team_name"] = work["team_name"]
        jp = work.get("jersey_number_primary")
        if jp is not None and str(jp).strip():
            seg["jersey_number_primary"] = str(jp).strip().lstrip("#")
