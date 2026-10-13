"""Report a model call that has gone quiet, without changing how it runs.

A request whose connection silently died looks, from the client, exactly like a
model that is still thinking: no bytes arrive either way, and the only signal is
the HTTP timeout, which for slow reasoning models has to be generous (minutes).
Until it fires the caller has nothing to show. ``ResponseWaitWatch`` measures
the silence and reports it through a callback once it crosses a threshold, and
again when data resumes or the call ends, so a host can tell its user what is
happening and let them decide whether to keep waiting.

It only observes. The request, its timeout and any retry the transport makes
are left exactly as they were.
"""

from __future__ import annotations

import asyncio
import inspect
import sys
import time
from datetime import datetime
from typing import Any, Callable, Literal, Optional

from pydantic import BaseModel

ResponseWaitPhase = Literal["first_response", "stream"]


class ResponseWait(BaseModel):
    """One change in whether a model call is waiting on its provider."""

    agent: str
    model: str
    phase: ResponseWaitPhase
    """``first_response`` when nothing has arrived for this call yet;
    ``stream`` when the response had started and then stopped."""
    elapsed_seconds: float
    """Seconds since the provider last sent data (or since the call started)."""
    waiting: bool
    """True when the silence crossed the threshold; False when it ended, either
    because data resumed or because the call finished or failed."""


class ResponseWaitWatch:
    """Background timer for one model call.

    ``progress()`` is called for every chunk received and must stay cheap: it
    stores a timestamp, and does more only when a notice is outstanding.
    ``stop()`` ends the watch and closes an outstanding notice.
    """

    def __init__(
        self,
        callback: Optional[Callable[[ResponseWait], Any]],
        *,
        agent: str,
        model: str,
        notice_after: Optional[float],
    ) -> None:
        self._callback = callback
        self._agent = agent
        self._model = model
        self._notice_after = notice_after
        self._last = time.monotonic()
        self._phase: ResponseWaitPhase = "first_response"
        self._noticed = False
        self._wake = asyncio.Event()
        self._task: Optional[asyncio.Task] = None

    def start(self) -> "ResponseWaitWatch":
        if self._callback is None or not self._notice_after or self._notice_after <= 0:
            return self
        self._task = asyncio.create_task(self._watch())
        return self

    async def progress(self) -> None:
        now = time.monotonic()
        silent_since = self._last
        self._last = now
        self._phase = "stream"
        if self._noticed:
            self._noticed = False
            self._wake.set()
            await self._emit(waiting=False, elapsed=now - silent_since, phase="stream")

    async def stop(self) -> None:
        if self._task is not None:
            # Not awaited: awaiting a task we just cancelled from inside a
            # `finally` could absorb a cancellation aimed at our own caller.
            self._task.cancel()
            self._task = None
        if self._noticed:
            self._noticed = False
            await self._emit(
                waiting=False, elapsed=time.monotonic() - self._last, phase=self._phase
            )

    async def _watch(self) -> None:
        while True:
            idle = time.monotonic() - self._last
            if idle < self._notice_after:
                await asyncio.sleep(self._notice_after - idle)
                continue
            if not self._noticed:
                self._noticed = True
                self._wake.clear()
                await self._emit(waiting=True, elapsed=idle, phase=self._phase)
            await self._wake.wait()

    async def _emit(self, *, waiting: bool, elapsed: float, phase: ResponseWaitPhase) -> None:
        record = ResponseWait(
            agent=self._agent,
            model=self._model,
            phase=phase,
            elapsed_seconds=elapsed,
            waiting=waiting,
        )
        try:
            result = self._callback(record)
            if inspect.isawaitable(result):
                await result
        except Exception as exc:
            # A notification hook must never take the model call down with it.
            print(
                f"[RESPONSE WAIT CALLBACK FAILED {datetime.now():%H:%M:%S}] "
                f"agent={self._agent} model={self._model}: {exc!r}",
                file=sys.stderr,
                flush=True,
            )
