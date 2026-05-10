"""State reconciliation and caption generation for live replay sessions."""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from dataclasses import dataclass, field
from typing import Any

from live_game_data import LiveGameEvent
from live_kb import PregameKnowledgeBase
from openai_retry import with_openai_retry


_ACTION_DETAIL_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"\balley[- ]oop\b", "alley-oop finish"),
    (r"\bputback\b|\bput back\b", "putback"),
    (r"\btip[- ]?in\b|\btip shot\b|\btip layup\b", "tip-in"),
    (r"\boffensive rebound\b|\boreb\b", "offensive rebound"),
    (r"\bdefensive rebound\b|\bdreb\b", "defensive rebound"),
    (r"\bstep[- ]?back\b.*\b(?:3pt|three|3-pointer|three-pointer)\b", "step-back three"),
    (r"\b(?:3pt|three|3-pointer|three-pointer)\b.*\bstep[- ]?back\b", "step-back three"),
    (r"\bpull ?up\b.*\b(?:3pt|three|3-pointer|three-pointer)\b", "pull-up three"),
    (r"\b(?:3pt|three|3-pointer|three-pointer)\b.*\bpull ?up\b", "pull-up three"),
    (r"\bstep[- ]?back\b", "step-back jumper"),
    (r"\bpull ?up\b", "pull-up jumper"),
    (r"\bdriving\b.*\bdunk\b", "driving dunk"),
    (r"\bdriving\b.*\blayup\b", "driving layup"),
    (r"\brunning\b.*\bdunk\b", "transition dunk"),
    (r"\brunning\b.*\blayup\b", "transition layup"),
    (r"\bfinger roll\b", "finger-roll finish"),
    (r"\bfadeaway\b|\bfade away\b", "fadeaway jumper"),
    (r"\bhook shot\b|\bjump hook\b", "hook shot"),
    (r"\bfloater\b|\brunner\b", "floater"),
    (r"\bturnaround\b", "turnaround jumper"),
    (r"\bcatch and shoot\b|\bcatch-and-shoot\b", "catch-and-shoot look"),
    (r"\bcutting\b|\bcuts? to the rim\b", "cut to the rim"),
    (r"\bscreen\b|\bpick[- ]and[- ]roll\b|\bpick and roll\b", "screen action"),
    (r"\bhelp defense\b|\bhelp defender\b|\bdefense collapses\b|\bcollapsing defense\b", "help defense"),
    (r"\breset\b|\bwalks? it up\b|\bsets? the offense\b", "reset spacing"),
    (r"\bbad pass\b|\blost ball\b", "live-ball turnover"),
    (r"\bsteal\b|\bstolen\b", "steal"),
    (r"\bblock\b|\bblocked\b", "block"),
    (r"\bdunk\b|\bslam\b", "dunk"),
    (r"\blayup\b", "layup"),
    (r"\b(?:3pt|three|3-pointer|three-pointer)\b", "three-point look"),
    (r"\bjump shot\b|\bjumper\b", "jumper"),
)


@dataclass(slots=True)
class VisualObservation:
    summary: str
    confidence: float
    changed: bool = False
    action_level: str = "medium"

    def __post_init__(self) -> None:
        level = (self.action_level or "").strip().lower()
        if level not in {"high", "medium", "low"}:
            level = "medium" if self.changed else "low"
        self.action_level = level


@dataclass(slots=True)
class FeedContext:
    period: int
    clock: str
    team_names: list[str]
    nearest_prior: LiveGameEvent | None = None
    nearest_next: LiveGameEvent | None = None
    last_score: str | None = None

    def description(self) -> str:
        parts = [f"Q{self.period} {self.clock}"]
        if self.last_score:
            parts.append(f"score {self.last_score}")
        if self.nearest_prior:
            parts.append(f"previous: {self.nearest_prior.description}")
        return " | ".join(parts)


@dataclass(slots=True)
class CaptionDecision:
    event_id: str
    period: int
    clock: str
    event_type: str
    player_name: str | None
    team_name: str | None
    score: str | None
    text: str
    source: str
    confidence: float
    model_name: str
    replay_time_sec: float
    feed_description: str | None = None
    visual_summary: str | None = None
    feed_context: dict[str, Any] | None = None
    latency_ms: int = 0
    caption_stage: str = "initial"
    generated_at: str = ""
    enriched_from_event_id: str | None = None

    def __post_init__(self) -> None:
        if not self.generated_at:
            self.generated_at = datetime.now(timezone.utc).isoformat()


@dataclass
class LiveStateReconciler:
    kb: PregameKnowledgeBase
    recent_captions: list[str] = field(default_factory=list)
    seen_event_ids: set[str] = field(default_factory=set)
    last_event_type: str | None = None
    last_possession_team: str | None = None

    def unseen_feed_events(self, events: list[LiveGameEvent]) -> list[LiveGameEvent]:
        out: list[LiveGameEvent] = []
        for event in events:
            if event.event_id in self.seen_event_ids:
                continue
            out.append(event)
        return out

    async def caption_for_feed_event(
        self,
        event: LiveGameEvent,
        *,
        replay_time_sec: float,
        visual: VisualObservation | None,
    ) -> CaptionDecision:
        if not os.getenv("OPENAI_API_KEY"):
            return self.fast_caption_for_feed_event(event, replay_time_sec=replay_time_sec, visual=visual)

        self.seen_event_ids.add(event.event_id)
        if event.team_name:
            self.last_possession_team = event.team_name
        self.last_event_type = event.event_type
        text, model = await generate_caption_text(
            event=event,
            kb=self.kb,
            recent_captions=self.recent_captions,
            visual=visual,
        )
        self._remember(text)
        context = FeedContext(
            period=event.period,
            clock=event.clock,
            team_names=self.kb.team_names,
            nearest_prior=event,
            last_score=event.score,
        )
        return CaptionDecision(
            event_id=event.event_id,
            period=event.period,
            clock=event.clock,
            event_type=event.event_type,
            player_name=event.player_name,
            team_name=event.team_name,
            score=event.score,
            text=text,
            source="feed_with_vision" if visual else "feed",
            confidence=0.92 if visual else 0.88,
            model_name=model,
            replay_time_sec=replay_time_sec,
            feed_description=event.description,
            visual_summary=visual.summary if visual else None,
            feed_context=feed_context_to_payload(context),
            caption_stage="enriched",
            enriched_from_event_id=event.event_id,
        )

    def fast_caption_for_feed_event(
        self,
        event: LiveGameEvent,
        *,
        replay_time_sec: float,
        visual: VisualObservation | None = None,
    ) -> CaptionDecision:
        self.seen_event_ids.add(event.event_id)
        if event.team_name:
            self.last_possession_team = event.team_name
        self.last_event_type = event.event_type
        text = template_caption(event, self.kb, visual)
        self._remember(text)
        context = FeedContext(
            period=event.period,
            clock=event.clock,
            team_names=self.kb.team_names,
            nearest_prior=event,
            last_score=event.score,
        )
        return CaptionDecision(
            event_id=event.event_id,
            period=event.period,
            clock=event.clock,
            event_type=event.event_type,
            player_name=event.player_name,
            team_name=event.team_name,
            score=event.score,
            text=text,
            source="feed_with_vision" if visual else "feed",
            confidence=0.9 if visual else 0.86,
            model_name="template-live",
            replay_time_sec=replay_time_sec,
            feed_description=event.description,
            visual_summary=visual.summary if visual else None,
            feed_context=feed_context_to_payload(context),
            caption_stage="initial",
        )

    async def enriched_caption_for_feed_event(
        self,
        event: LiveGameEvent,
        *,
        replay_time_sec: float,
        visual: VisualObservation | None,
        recent_captions: list[str] | None = None,
    ) -> CaptionDecision:
        text, model = await generate_caption_text(
            event=event,
            kb=self.kb,
            recent_captions=recent_captions if recent_captions is not None else self.recent_captions,
            visual=visual,
        )
        context = FeedContext(
            period=event.period,
            clock=event.clock,
            team_names=self.kb.team_names,
            nearest_prior=event,
            last_score=event.score,
        )
        return CaptionDecision(
            event_id=event.event_id,
            period=event.period,
            clock=event.clock,
            event_type=event.event_type,
            player_name=event.player_name,
            team_name=event.team_name,
            score=event.score,
            text=text,
            source="feed_with_vision" if visual else "feed",
            confidence=0.94 if visual else 0.9,
            model_name=model,
            replay_time_sec=replay_time_sec,
            feed_description=event.description,
            visual_summary=visual.summary if visual else None,
            feed_context=feed_context_to_payload(context),
            caption_stage="enriched",
            enriched_from_event_id=event.event_id,
        )

    async def caption_for_feed_context(
        self,
        *,
        period: int,
        clock: str,
        replay_time_sec: float,
        visual: VisualObservation | None,
        context: FeedContext,
    ) -> CaptionDecision | None:
        if not visual or not visual.changed:
            return None
        event_id = f"feed-context-{period}-{clock}-{int(replay_time_sec)}"
        if event_id in self.seen_event_ids:
            return None
        self.seen_event_ids.add(event_id)
        text, model = await generate_context_caption_text(
            context=context,
            kb=self.kb,
            recent_captions=self.recent_captions,
            visual=visual,
        )
        self._remember(text)
        return CaptionDecision(
            event_id=event_id,
            period=period,
            clock=clock,
            event_type="feed_context",
            player_name=None,
            team_name=self.last_possession_team or context_team_name(context),
            score=context.last_score,
            text=text,
            source="feed_context_with_vision",
            confidence=min(0.72, max(0.45, visual.confidence)),
            model_name=model,
            replay_time_sec=replay_time_sec,
            feed_description=context.description(),
            visual_summary=visual.summary,
            feed_context=feed_context_to_payload(context),
        )

    def _remember(self, text: str) -> None:
        self.recent_captions.append(text)
        del self.recent_captions[:-5]


async def generate_caption_text(
    *,
    event: LiveGameEvent,
    kb: PregameKnowledgeBase,
    recent_captions: list[str],
    visual: VisualObservation | None,
) -> tuple[str, str]:
    action_detail = action_detail_for_event(event, visual)
    if not os.getenv("OPENAI_API_KEY"):
        return template_caption(event, kb, visual), "template-live"

    from openai import AsyncOpenAI

    facts = kb.facts_for(event.player_name, event.team_name)
    context = FeedContext(
        period=event.period,
        clock=event.clock,
        team_names=kb.team_names,
        nearest_prior=event,
        last_score=event.score,
    )
    payload: dict[str, Any] = {
        "event_type": event.event_type,
        "description": event.description,
        "player_name": event.player_name,
        "team_name": event.team_name,
        "period": event.period,
        "clock": event.clock,
        "score": event.score,
        "action_detail": action_detail,
        "feed_context": feed_context_to_payload(context),
        "pregame_facts": facts,
        "recent_captions": recent_captions[-3:],
        "visual_evidence": visual.summary if visual else None,
        "visual_action_level": visual.action_level if visual else None,
    }
    prompt = (
        "Write exactly one concise live NBA caption, 10-22 words.\n"
        "Structured play-by-play is the source of truth for names, score, and outcomes. "
        "Do not invent stats, score, player names, or outcomes.\n"
        "When action_detail is present and an exact player is provided, lead naturally with that player and move "
        "unless recent_captions already used the same rhythm.\n"
        "When visual_evidence exists, make the caption descriptive about the player's movement, ball movement, "
        "spacing, defensive coverage, or the visible basketball action.\n"
        "Do not write a generic line that only restates the feed description when visual_evidence adds gameplay detail.\n"
        "Do not force move detail into every caption; vary between play-by-play, movement detail, score/clock context, "
        "and tactical context like coverage or spacing.\n"
        "Use one pregame fact only if it naturally fits. Avoid repeating recent captions.\n\n"
        f"Data:\n{json.dumps(payload, indent=2)}\n\n"
        "Return plain text only."
    )
    client = AsyncOpenAI()

    async def _call():
        return await client.chat.completions.create(
            model=os.getenv("OPENAI_TEXT_MODEL", "gpt-4o-mini"),
            messages=[{"role": "user", "content": prompt}],
            temperature=0.45,
            max_tokens=80,
        )

    resp = await with_openai_retry(_call, label="live_caption")
    text = (resp.choices[0].message.content or "").strip().strip('"')
    return text or template_caption(event, kb, visual), os.getenv("OPENAI_TEXT_MODEL", "gpt-4o-mini")


async def generate_context_caption_text(
    *,
    context: FeedContext,
    kb: PregameKnowledgeBase,
    recent_captions: list[str],
    visual: VisualObservation,
) -> tuple[str, str]:
    visual_action_detail = action_detail_from_text(visual.summary)
    payload: dict[str, Any] = {
        "feed_context": feed_context_to_payload(context),
        "action_detail": visual_action_detail,
        "pregame_facts": kb.facts_for(None, context_team_name(context)),
        "recent_captions": recent_captions[-3:],
        "visual_evidence": visual.summary,
        "visual_action_level": visual.action_level,
    }
    if not os.getenv("OPENAI_API_KEY"):
        return template_context_caption(context, visual), "template-live-context"

    from openai import AsyncOpenAI

    prompt = (
        "Write exactly one concise live NBA caption, 10-22 words.\n"
        "Every caption must be grounded in feed_context. Use the current game clock, teams, or score when useful.\n"
        "This payload has no exact play-by-play event for the current video window.\n"
        "No future play-by-play is provided. Do not predict or hint at upcoming outcomes.\n"
        "Do not state a specific player, scoring result, rebound, turnover, foul, assist, or made/missed shot "
        "unless it appears in an exact matched event. Here there is no exact matched event.\n"
        "If visual_action_level is high or medium, describe only the visible current gameplay, action_detail, "
        "and already elapsed context.\n"
        "If visual_action_level is low, write analysis instead: spacing, pace, shot-clock pressure, matchup positioning, "
        "current score/time context, or tactical setup already visible.\n"
        "Avoid starting with 'Visually,' unless there is no natural feed-aware wording.\n\n"
        f"Data:\n{json.dumps(payload, indent=2)}\n\n"
        "Return plain text only."
    )
    client = AsyncOpenAI()

    async def _call():
        return await client.chat.completions.create(
            model=os.getenv("OPENAI_TEXT_MODEL", "gpt-4o-mini"),
            messages=[{"role": "user", "content": prompt}],
            temperature=0.35,
            max_tokens=80,
        )

    resp = await with_openai_retry(_call, label="live_context_caption")
    text = (resp.choices[0].message.content or "").strip().strip('"')
    return text or template_context_caption(context, visual), os.getenv("OPENAI_TEXT_MODEL", "gpt-4o-mini")


def template_caption(
    event: LiveGameEvent,
    kb: PregameKnowledgeBase,
    visual: VisualObservation | None,
) -> str:
    subject = event.player_name or event.team_name or "The offense"
    desc = event.description.rstrip(".")
    action_detail = action_detail_for_event(event, visual)
    feed_line = feed_action_line(event, subject, action_detail)
    if feed_line:
        base = feed_line
    elif event.event_type in {"made_shot", "missed_shot", "free_throw", "turnover", "rebound", "foul"}:
        base = f"{subject}: {desc}."
    else:
        base = f"{desc}."
    if event.event_type in {"made_shot", "missed_shot", "free_throw", "turnover", "rebound", "foul"}:
        base = maybe_append_score(base, event.score)
    facts = kb.facts_for(event.player_name, event.team_name, limit=1)
    if visual and visual.summary and visual.action_level in {"high", "medium"} and len(base.split()) < 18:
        movement = visual.summary.strip().rstrip(".")
        if movement.lower() not in base.lower():
            base = f"{base} {movement}."
    elif facts and len(base.split()) < 17:
        base = f"{base} {facts[0]}"
    return " ".join(base.split()[:28])


def template_context_caption(context: FeedContext, visual: VisualObservation) -> str:
    teams = " vs. ".join(context.team_names[:2]) or "the teams"
    score = f" with the score at {context.last_score}" if context.last_score else ""
    summary = visual.summary.strip().rstrip(".") or "the possession develops"
    action_detail = action_detail_from_text(summary)
    if visual.action_level == "low":
        setup = "settle into spacing and tempo"
        if context.nearest_prior:
            setup = "organize after the previous action"
        return f"At Q{context.period} {context.clock}{score}, {teams} {setup}, reading the current matchups."
    if action_detail:
        return f"At Q{context.period} {context.clock}{score}, {teams} work through {action_detail} as {summary}."
    return f"At Q{context.period} {context.clock}{score}, {teams} flow through the possession as {summary}."


def action_detail_for_event(event: LiveGameEvent, visual: VisualObservation | None = None) -> str | None:
    return action_detail_from_text(event.description) or action_detail_from_text(visual.summary if visual else None)


def action_detail_from_text(text: str | None) -> str | None:
    raw = (text or "").strip().lower()
    if not raw:
        return None
    compact = re.sub(r"[^a-z0-9\s-]", " ", raw)
    compact = re.sub(r"\s+", " ", compact)
    for pattern, detail in _ACTION_DETAIL_PATTERNS:
        if re.search(pattern, compact):
            return detail
    return None


def feed_action_line(event: LiveGameEvent, subject: str, action_detail: str | None) -> str | None:
    if not action_detail:
        return None
    team = f" for {event.team_name}" if event.team_name and event.player_name else ""
    if action_detail == "live-ball turnover":
        return f"{subject} turns it over on a live-ball mistake{team}."
    if action_detail == "steal":
        return f"{subject} comes away with the steal{team}."
    if action_detail == "block":
        return f"{subject} comes up with the block{team}."
    outcome = event_outcome_phrase(event)
    if outcome:
        article = "" if action_detail in {"offensive rebound", "defensive rebound"} else "the "
        return f"{subject} {outcome} {article}{action_detail}{team}."
    return f"{subject} is in the middle of {action_detail}{team}."


def event_outcome_phrase(event: LiveGameEvent) -> str:
    if event.event_type == "made_shot":
        return "finishes"
    if event.event_type == "missed_shot":
        return "gets to"
    if event.event_type == "rebound":
        return "controls"
    if event.event_type == "turnover":
        return "loses"
    if event.event_type == "steal":
        return "jumps"
    if event.event_type == "block":
        return "meets"
    return ""


def maybe_append_score(text: str, score: str | None) -> str:
    if not score or score in text:
        return text
    return f"{text.rstrip('.')} and it's {score}."


def context_team_name(context: FeedContext) -> str | None:
    if context.nearest_prior and context.nearest_prior.team_name:
        return context.nearest_prior.team_name
    return context.team_names[0] if context.team_names else None


def feed_context_to_payload(context: FeedContext) -> dict[str, Any]:
    return {
        "period": context.period,
        "clock": context.clock,
        "teams": context.team_names,
        "last_score": context.last_score,
        "nearest_prior_event": event_to_payload(context.nearest_prior),
    }


def event_to_payload(event: LiveGameEvent | None) -> dict[str, Any] | None:
    if event is None:
        return None
    return {
        "event_id": event.event_id,
        "period": event.period,
        "clock": event.clock,
        "event_type": event.event_type,
        "description": event.description,
        "player_name": event.player_name,
        "team_name": event.team_name,
        "score": event.score,
    }
