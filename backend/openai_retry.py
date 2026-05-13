"""
OpenAI client helpers: limit concurrent calls and retry 429 / transient errors.

- 429 / rate limits: exponential backoff with jitter, combined with any
  "try again in X ms" hint from the API (we wait at least the longer of the two).
- Concurrency: small process-wide semaphore so many endpoints don't burst TPM together.
"""

from __future__ import annotations

import asyncio
import logging
import os
import random
import re
import threading
import time
from typing import Awaitable, Callable, TypeVar

logger = logging.getLogger("vision2voice.openai_retry")

T = TypeVar("T")

# Limits how many OpenAI HTTP calls run at once (async + sync), to avoid TPM spikes from parallelism.
_async_openai_sem: asyncio.Semaphore | None = None
_sync_openai_sem: threading.Semaphore | None = None


def _retry_max_attempts() -> int:
    return max(1, int(os.getenv("OPENAI_RETRY_MAX_ATTEMPTS", "8")))


def _retry_base_sec() -> float:
    return max(0.05, float(os.getenv("OPENAI_RETRY_BASE_SEC", "0.75")))


def _retry_max_wait_sec() -> float:
    return max(0.1, float(os.getenv("OPENAI_RETRY_MAX_WAIT_SEC", "90")))


def _openai_max_concurrent() -> int:
    """Cap parallel OpenAI requests (same org shares one TPM bucket)."""
    return max(1, int(os.getenv("OPENAI_MAX_CONCURRENT_REQUESTS", "2")))


def _get_async_openai_sem() -> asyncio.Semaphore:
    global _async_openai_sem
    if _async_openai_sem is None:
        _async_openai_sem = asyncio.Semaphore(_openai_max_concurrent())
    return _async_openai_sem


def _get_sync_openai_sem() -> threading.Semaphore:
    global _sync_openai_sem
    if _sync_openai_sem is None:
        _sync_openai_sem = threading.Semaphore(_openai_max_concurrent())
    return _sync_openai_sem


def _parse_try_again_ms(message: str) -> float | None:
    m = re.search(r"try again in\s+(\d+(?:\.\d+)?)\s*ms", message, re.IGNORECASE)
    if m:
        return max(0.05, float(m.group(1)) / 1000.0)
    return None


def _is_retryable(exc: BaseException) -> bool:
    try:
        from openai import APIConnectionError, APIStatusError, RateLimitError
    except ImportError:
        return False
    if isinstance(exc, RateLimitError):
        return True
    if isinstance(exc, APIConnectionError):
        return True
    if isinstance(exc, APIStatusError):
        return exc.status_code in (429, 502, 503, 504)
    return False


def _sleep_seconds(exc: BaseException, attempt: int) -> float:
    """
    Wait before retrying: exponential backoff + jitter, capped.
    If the API message includes "try again in X ms", we wait at least that long
    AND at least the exponential delay (TPM limits often need both).
    """
    cap = _retry_max_wait_sec()
    msg = str(exc)
    hint = _parse_try_again_ms(msg)
    base = _retry_base_sec()
    # Exponential backoff: base * 2^(attempt-1), plus small jitter
    exp_backoff = base * (2 ** (attempt - 1)) + random.uniform(0, base * 0.5)
    exp_backoff = min(cap, exp_backoff)
    if hint is not None:
        return min(cap, max(exp_backoff, hint + random.uniform(0.08, 0.35)))
    return exp_backoff


async def with_openai_retry(call: Callable[[], Awaitable[T]], *, label: str = "openai") -> T:
    """
    Run one OpenAI async call with:
    - a process-wide concurrency limit (fewer overlapping token charges),
    - retries on 429 / transient errors with exponential backoff.
    """
    async with _get_async_openai_sem():
        max_attempts = _retry_max_attempts()
        for attempt in range(1, max_attempts + 1):
            try:
                return await call()
            except BaseException as e:
                if not _is_retryable(e) or attempt >= max_attempts:
                    raise
                wait = _sleep_seconds(e, attempt)
                logger.warning(
                    "%s: retryable OpenAI error (%s/%s), sleeping %.2fs: %s",
                    label,
                    attempt,
                    max_attempts,
                    wait,
                    e,
                )
                await asyncio.sleep(wait)
    raise RuntimeError("with_openai_retry: unreachable")


def with_openai_retry_sync(call: Callable[[], T], *, label: str = "openai") -> T:
    """Same as with_openai_retry for blocking OpenAI SDK calls (e.g. TTS)."""
    sem = _get_sync_openai_sem()
    sem.acquire()
    try:
        max_attempts = _retry_max_attempts()
        for attempt in range(1, max_attempts + 1):
            try:
                return call()
            except BaseException as e:
                if not _is_retryable(e) or attempt >= max_attempts:
                    raise
                wait = _sleep_seconds(e, attempt)
                logger.warning(
                    "%s: retryable OpenAI error (%s/%s), sleeping %.2fs: %s",
                    label,
                    attempt,
                    max_attempts,
                    wait,
                    e,
                )
                time.sleep(wait)
        raise RuntimeError("with_openai_retry_sync: unreachable")
    finally:
        sem.release()
