#!/usr/bin/env python3
"""Browser-level checks for the deck editor.

    npm run test:browser              both interface scales
    npm run test:browser -- 1         one scale
    npm run test:browser -- --headful watch it run

Why this exists, when there are already 48 unit tests
-----------------------------------------------------
The unit suite covers everything that can be made pure: the deck model's
round-trip, the resize and rotation maths, click pairing. It cannot see whether
a click reaches an element, whether a panel is covered, whether focus survives
the press that opened an editor, or whether a projected slide fits the screen.
Every defect this editor has shipped so far lived in exactly that gap:

  * the canvas painting over the properties panel  (layout under a CSS zoom)
  * double-click not entering text editing         (event semantics, then focus)
  * the projected slide clipped at the corner      (viewport units under a zoom)

None of the three was reachable from a unit test, and each reached a user. So
the checks below drive a real browser with *real* input: mouse events are
dispatched through the DevTools Protocol, which delivers them the way the
operating system does. That distinction is not academic — an earlier version of
these checks used synthetic `dispatchEvent` and passed against a broken double
click, because the test author had set a field (`detail`) that real Chrome
always reports as 0. A test that invents its own inputs proves nothing.

Requires Google Chrome (or Chromium) and the `websockets` package, both of which
the project already depends on for other reasons.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

try:
    import websockets
except ImportError:  # pragma: no cover - environment guard
    sys.exit("browser tests need the 'websockets' package: pip install websockets")

HERE = os.path.dirname(os.path.abspath(__file__))
GUI_SRC = os.path.dirname(os.path.dirname(HERE))
HARNESS_PATH = "/test/browser/harness.html"
STORE_PATH = "/test/browser/store.html"

# Wide enough that the editor lays out its three columns, and a shape at the
# far corner of the slide still has somewhere to overflow to if it wants.
WINDOW = (1440, 900)

CHROME_CANDIDATES = [
    "google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
    "microsoft-edge",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]


def find_chrome() -> str:
    for candidate in CHROME_CANDIDATES:
        found = shutil.which(candidate) or (candidate if os.path.exists(candidate) else None)
        if found:
            return found
    sys.exit(
        "no Chrome or Chromium found. These checks drive a real browser; install one, "
        "or run only the pure suites with `npm run test:slides`."
    )


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_for(url: str, timeout: float = 40.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(url, timeout=1)
            return
        except (urllib.error.URLError, OSError):
            time.sleep(0.25)
    raise TimeoutError(f"timed out waiting for {url}")


class Checks:
    """Collects results so one failure does not hide the rest."""

    def __init__(self) -> None:
        self.rows: list[tuple[str, bool, str]] = []

    def __call__(self, name: str, ok: bool, detail: str = "") -> bool:
        self.rows.append((name, bool(ok), detail))
        return bool(ok)

    @property
    def failed(self) -> int:
        return sum(1 for _, ok, _ in self.rows if not ok)

    def report(self, label: str) -> None:
        passed = len(self.rows) - self.failed
        print(f"--- {label}: {passed}/{len(self.rows)} pass ---")
        for name, ok, detail in self.rows:
            print(("  PASS " if ok else "  FAIL "), name.ljust(34), detail)


class Page:
    """A very small DevTools Protocol client: evaluate, and dispatch input."""

    def __init__(self, ws, url: str) -> None:
        self._ws = ws
        self._id = 0
        self.url = url          # so a step can reload a pristine fixture

    async def reload(self) -> None:
        """Back to the fixture as authored."""
        await self.cmd("Page.navigate", {"url": self.url})
        deadline = time.time() + 30
        while time.time() < deadline:
            if await self.js("!!window.__ready && !!document.querySelector('.deck-canvas')"):
                await asyncio.sleep(0.4)
                return
            await asyncio.sleep(0.2)
        raise TimeoutError("harness did not reload")

    async def cmd(self, method: str, params: dict | None = None) -> dict:
        self._id += 1
        await self._ws.send(json.dumps({"id": self._id, "method": method, "params": params or {}}))
        while True:
            message = json.loads(await self._ws.recv())
            if message.get("id") == self._id:
                if "error" in message:
                    raise RuntimeError(f"{method}: {message['error']}")
                return message.get("result", {})

    async def js(self, expression: str):
        result = await self.cmd("Runtime.evaluate", {
            "expression": expression, "returnByValue": True, "awaitPromise": True,
        })
        if "exceptionDetails" in result:
            raise RuntimeError(f"page error: {result['exceptionDetails'].get('text')}")
        return result.get("result", {}).get("value")

    # ── real input ───────────────────────────────────────────────────────────
    async def _mouse(self, kind: str, x: float, y: float, clicks: int) -> None:
        await self.cmd("Input.dispatchMouseEvent", {
            "type": kind, "x": x, "y": y, "button": "left",
            "buttons": 0 if kind == "mouseReleased" else 1, "clickCount": clicks,
        })

    async def press(self, x, y, clicks=1): await self._mouse("mousePressed", x, y, clicks)
    async def release(self, x, y, clicks=1): await self._mouse("mouseReleased", x, y, clicks)
    async def move(self, x, y): await self._mouse("mouseMoved", x, y, 0)

    async def right_click(self, x: float, y: float) -> None:
        """A real secondary click. Which of press/release carries `contextmenu`
        is a platform detail, so both are dispatched and the page decides."""
        for kind, buttons in (("mousePressed", 2), ("mouseReleased", 0)):
            await self.cmd("Input.dispatchMouseEvent", {
                "type": kind, "x": x, "y": y, "button": "right",
                "buttons": buttons, "clickCount": 1,
            })

    async def chord(self, key: str, code: str, key_code: int) -> None:
        """Ctrl + a letter, as the operating system delivers it."""
        for kind in ("keyDown", "keyUp"):
            await self.cmd("Input.dispatchKeyEvent", {
                "type": kind, "key": key, "code": code,
                "windowsVirtualKeyCode": key_code, "nativeVirtualKeyCode": key_code,
                "modifiers": 2,     # Ctrl
            })

    async def key(self, key: str, key_code: int, modifiers: int = 0,
                  text: str | None = None, code: str | None = None) -> None:
        """A key, as the operating system delivers it.

        `text` is what the key would type, and Enter is the reason it exists:
        without it Chrome delivers the keystroke but inserts nothing, so a test
        for what Enter does to a line would pass against an editor that does
        nothing at all.
        """
        for kind in ("keyDown", "keyUp"):
            event = {
                "type": kind, "key": key, "code": code or key,
                "windowsVirtualKeyCode": key_code, "nativeVirtualKeyCode": key_code,
                "modifiers": modifiers,
            }
            if text and kind == "keyDown":
                event["text"] = text
            await self.cmd("Input.dispatchKeyEvent", event)

    async def click(self, x, y, clicks=1) -> None:
        await self.press(x, y, clicks)
        await self.release(x, y, clicks)

    async def double_click(self, x, y) -> None:
        """The sequence a real double click produces, at real double-click speed."""
        await self.click(x, y, 1)
        await asyncio.sleep(0.06)
        await self.click(x, y, 2)

    async def type_text(self, text: str) -> None:
        await self.cmd("Input.insertText", {"text": text})

    async def rect(self, selector: str, index: int = 0):
        return await self.js(
            "(() => {"
            f"  const el = document.querySelectorAll({json.dumps(selector)})[{index}];"
            "   if (!el) return null;"
            "   const r = el.getBoundingClientRect();"
            "   return {x: r.left, y: r.top, w: r.width, h: r.height,"
            "           cx: r.left + r.width / 2, cy: r.top + r.height / 2,"
            "           right: r.right, bottom: r.bottom};"
            "})()"
        )


# ─── the checks ──────────────────────────────────────────────────────────────
# Each group states what only a browser can answer. Gestures are separated by
# more than the double-click window (450ms) wherever two clicks would otherwise
# be paired into one the test never meant to perform.

SETTLE = 0.25
UNPAIR = 0.6


async def check_layout(page: Page, check: Checks) -> None:
    """The canvas must not paint over the panels beside it.

    A scaled element keeps its untransformed layout box, so a 1280px canvas at
    40% still occupies 1280px of layout. This is the check that would have
    caught the slide covering the properties panel.
    """
    stage = await page.rect(".deck-stage")
    props = await page.rect(".deck-props")
    canvas = await page.rect(".deck-canvas")
    if not check("editor mounted", all((stage, props, canvas))):
        return
    check("canvas inside stage", canvas["right"] <= stage["right"] + 1,
          f"canvas.right={canvas['right']:.0f} stage.right={stage['right']:.0f}")
    check("stage clear of properties", stage["right"] <= props["x"] + 1,
          f"stage.right={stage['right']:.0f} props.left={props['x']:.0f}")


async def check_selection(page: Page, check: Checks) -> None:
    title = await page.rect(".deck-element")
    await page.click(title["cx"], title["cy"])
    await asyncio.sleep(SETTLE)
    resize = await page.js("document.querySelectorAll('.deck-handle:not(.deck-handle-rotate)').length")
    rotate = await page.js("document.querySelectorAll('.deck-handle-rotate').length")
    check("click selects", resize == 8 and rotate == 1, f"resize={resize} rotate={rotate}")


async def check_text_editing(page: Page, check: Checks) -> None:
    """Double click opens the editor, and the editor survives the press.

    Two independent defects live here. The click count is not on `pointerdown`
    (Chrome reports 0), and the press that opens the editor will, left to its
    default action, move focus to the nearest focusable ancestor *after* the
    contentEditable has mounted — closing the box in the tick it opened.
    """
    await asyncio.sleep(UNPAIR)
    title = await page.rect(".deck-element")
    await page.double_click(title["cx"], title["cy"])
    await asyncio.sleep(0.3)

    state = await page.js(
        "(() => ({editing: !!document.querySelector('.deck-text-editing'),"
        " active: document.activeElement && document.activeElement.className || ''}))()"
    )
    if not check("double click opens the editor", state["editing"],
                 f"activeElement={state['active'] or 'none'}"):
        check("typing appends at the caret", False, "editor never opened")
        check("text commits on blur", False, "editor never opened")
        return

    check("caret is in the text box", "deck-text-editing" in state["active"],
          f"activeElement={state['active']}")

    await page.type_text(" EDITADO")
    await asyncio.sleep(0.12)
    typed = await page.js("document.querySelector('.deck-text-editing').innerText")
    check("typing appends at the caret", typed == "Teste EDITADO", f"in editor={typed!r}")

    await asyncio.sleep(UNPAIR)
    stage = await page.rect(".deck-stage")
    await page.click(stage["cx"], stage["y"] + 12)
    await asyncio.sleep(0.3)
    committed = await page.js("document.querySelectorAll('.deck-element')[0].innerText")
    check("text commits on blur", committed == "Teste EDITADO", f"committed={committed!r}")
    check("editor closes on blur", await page.js("!document.querySelector('.deck-text-editing')"))


async def check_drag(page: Page, check: Checks) -> None:
    """A drag must move the element by the pointer delta, not a multiple of it.

    The app renders inside a CSS zoom, and pointer coordinates arrive in real
    viewport pixels; a missing conversion shows up here as a proportional error.
    """
    await asyncio.sleep(UNPAIR)
    before = await page.rect(".deck-element")
    await page.press(before["cx"], before["cy"])
    await page.move(before["cx"] + 60, before["cy"] + 30)
    await page.move(before["cx"] + 120, before["cy"] + 60)
    await asyncio.sleep(0.1)
    await page.release(before["cx"] + 120, before["cy"] + 60)
    await asyncio.sleep(SETTLE)
    after = await page.rect(".deck-element")
    dx, dy = after["x"] - before["x"], after["y"] - before["y"]
    # Snapping may trim a few pixels; a zoom-boundary bug is proportional and
    # far larger than that.
    check("drag follows the pointer", abs(dx - 120) < 14 and abs(dy - 60) < 14,
          f"dx={dx:.1f} (want 120) dy={dy:.1f} (want 60)")


async def check_rotation(page: Page, check: Checks) -> None:
    """Rotation, and the resize correction that rotation makes necessary."""
    await asyncio.sleep(UNPAIR)
    box = await page.js(
        "(() => { const els = [...document.querySelectorAll('.deck-element')];"
        " const i = els.findIndex(e => e.querySelector('div[style*=\"border-radius: 10px\"]'));"
        " const el = els[i >= 0 ? i : 4]; const r = el.getBoundingClientRect();"
        " return {cx: r.left + r.width / 2, cy: r.top + r.height / 2}; })()"
    )
    await page.click(box["cx"], box["cy"])
    await asyncio.sleep(SETTLE)

    handle = await page.rect(".deck-handle-rotate")
    frame = await page.rect(".deck-selection")
    if not check("rotation handle appears", handle is not None):
        return
    check("rotation handle sits above the box", handle["cy"] < frame["y"],
          f"handle.cy={handle['cy']:.0f} frame.top={frame['y']:.0f}")

    # Straight above the centre is 0 degrees; straight right of it is 90.
    await page.press(handle["cx"], handle["cy"])
    await page.move(frame["cx"] + 200, frame["cy"] - 100)
    await page.move(frame["cx"] + 260, frame["cy"])
    await asyncio.sleep(0.12)
    await page.release(frame["cx"] + 260, frame["cy"])
    await asyncio.sleep(0.3)

    el = await page.js("window.__element('thebox')")
    if not check("rotation handle turns the element", el and abs(el["rotation"] - 90) <= 2,
                 f"rotation={el and el['rotation']}"):
        return
    check("selection frame turns with it",
          (await page.js("getComputedStyle(document.querySelector('.deck-selection')).transform")) != "none")

    await asyncio.sleep(UNPAIR)
    before = await page.js("window.__element('thebox')")
    se = await page.rect(".deck-handle-se")
    if not check("resize handles follow the rotation", se is not None):
        return
    await page.press(se["cx"], se["cy"])
    await page.move(se["cx"], se["cy"] + 40)
    await page.move(se["cx"], se["cy"] + 80)
    await asyncio.sleep(0.12)
    await page.release(se["cx"], se["cy"] + 80)
    await asyncio.sleep(0.3)
    after = await page.js("window.__element('thebox')")

    # At 90 degrees the element's local +x runs down the screen, so a downward
    # drag of the south-east handle widens it and leaves the height alone.
    dw = after["w"] - before["w"]
    dh = after["h"] - before["h"]
    check("rotated resize uses the element's axes", dw > 60 and abs(dh) < 12,
          f"dw={dw:.0f} dh={dh:.0f}")

    def corner_nw(e):
        cx, cy = e["x"] + e["w"] / 2, e["y"] + e["h"] / 2
        a = math.radians(e["rotation"])
        lx, ly = -e["w"] / 2, -e["h"] / 2
        return (cx + lx * math.cos(a) - ly * math.sin(a),
                cy + lx * math.sin(a) + ly * math.cos(a))

    b, a2 = corner_nw(before), corner_nw(after)
    drift = math.hypot(a2[0] - b[0], a2[1] - b[1])
    check("the anchored corner stays put", drift < 2.0, f"drift={drift:.2f} deck units")


async def check_arrows(page: Page, check: Checks) -> None:
    heads = await page.js("document.querySelectorAll('.deck-canvas polygon').length")
    check("arrowheads render", heads == 3, f"polygons={heads} (one single + one double)")


async def check_border(page: Page, check: Checks) -> None:
    """The border toggle in the properties panel reaches both the file and the pixels.

    The model side is unit-tested; what only a browser can answer is whether the
    control is wired to the selected element and whether the border it sets is
    actually painted. It reloads first because the gesture steps before it have
    moved and rotated the fixture, and it drives the rectangle rather than the
    title text so the shape group is the one on screen.
    """
    await page.reload()
    # Fixture order: title, subtitle, two ellipses, then `thebox`.
    box = await page.rect(".deck-element", 4)
    if not check("the box is where the fixture put it", box is not None):
        return
    await page.click(box["cx"], box["cy"])
    await asyncio.sleep(SETTLE)

    toggle = await page.js(
        "(() => { const b = [...document.querySelectorAll('.deck-props .deck-btn')]"
        "   .find(x => /^(Border|Borda)$/.test(x.getAttribute('title') || ''));"
        "  if (!b) return null; const r = b.getBoundingClientRect();"
        "  return {x: r.left + r.width / 2, y: r.top + r.height / 2}; })()"
    )
    if not check("border toggle found", toggle is not None):
        return

    await asyncio.sleep(UNPAIR)
    await page.click(toggle["x"], toggle["y"])
    await asyncio.sleep(SETTLE)
    el = await page.js("window.__element('thebox')")
    check("the toggle writes a border to the file",
          el and el["strokeWidth"] > 0 and bool(el["stroke"]),
          f"stroke={el and el['stroke']} width={el and el['strokeWidth']}")
    painted = await page.js(
        "(() => { const el = document.querySelectorAll('.deck-element')[4];"
        "  const box = el && el.firstElementChild;"
        "  return box ? getComputedStyle(box).borderTopWidth : null; })()"
    )
    check("and the border is painted", painted not in (None, "0px"), f"border-top-width={painted}")

    await asyncio.sleep(UNPAIR)
    await page.click(toggle["x"], toggle["y"])
    await asyncio.sleep(SETTLE)
    off = await page.js("window.__element('thebox')")
    check("toggling it off removes it", off and off["strokeWidth"] == 0,
          f"width={off and off['strokeWidth']}")


async def check_clipboard(page: Page, check: Checks) -> None:
    """The context menu and the clipboard, which are pure interaction.

    None of this is reachable from the pure suite. Whether a secondary click
    actually produces a `contextmenu` event on the element under the pointer,
    whether the menu it opens lands inside the window once the app's CSS zoom
    has been applied to its coordinates, whether Ctrl+C reaches the editor
    rather than the browser — every one of those is a property of real input,
    and each is exactly the kind of gap the three shipped defects lived in.
    """
    await page.reload()
    # Fixture order: title, subtitle, two ellipses, then `thebox`.
    box = await page.rect(".deck-element", 4)
    if not check("the box is where the fixture put it", box is not None):
        return

    await page.right_click(box["cx"], box["cy"])
    await asyncio.sleep(SETTLE)
    menu = await page.rect("[data-testid='deck-context-menu']")
    if not check("right click opens the slide menu", menu is not None):
        return

    viewport = await page.js("({w: innerWidth, h: innerHeight})")
    check("the menu lands inside the window",
          menu["right"] <= viewport["w"] + 1 and menu["bottom"] <= viewport["h"] + 1
          and menu["x"] >= -1 and menu["y"] >= -1,
          f"menu r={menu['right']:.0f} b={menu['bottom']:.0f} "
          f"viewport={viewport['w']}x{viewport['h']}")
    check("right click selects what it points at",
          await page.js("!!document.querySelector('.deck-selection')"))

    disabled = await page.js(
        "[...document.querySelectorAll('[data-testid^=\"deck-menu-\"]')]"
        "  .filter(e => e.classList.contains('vscode-context-menu-item-disabled'))"
        "  .map(e => e.dataset.testid)"
    )
    check("every item is offered on an element", disabled == [], f"disabled={disabled}")

    before = await page.js("window.__deck().slides[0].elements.length")
    item = await page.rect("[data-testid='deck-menu-duplicate']")
    await asyncio.sleep(UNPAIR)
    await page.click(item["cx"], item["cy"])
    await asyncio.sleep(SETTLE)
    after = await page.js("window.__deck().slides[0].elements")
    check("duplicate through the menu adds one element", len(after) == before + 1,
          f"{before} -> {len(after)}")
    if len(after) == before + 1:
        source = next(e for e in after if e["id"] == "thebox")
        copy = after[-1]
        check("the copy is a new element beside the original",
              copy["id"] != source["id"] and copy["x"] == source["x"] + 24
              and copy["y"] == source["y"] + 24,
              f"copy at ({copy['x']}, {copy['y']}) source at ({source['x']}, {source['y']})")
    check("the menu closes once it has acted",
          await page.js("!document.querySelector('[data-testid=\"deck-context-menu\"]')"))

    # On the slide background there is nothing to copy, so only Paste is live.
    canvas = await page.rect(".deck-canvas")
    await asyncio.sleep(UNPAIR)
    await page.right_click(canvas["cx"], canvas["y"] + canvas["h"] * 0.08)
    await asyncio.sleep(SETTLE)
    disabled = await page.js(
        "[...document.querySelectorAll('[data-testid^=\"deck-menu-\"]')]"
        "  .filter(e => e.classList.contains('vscode-context-menu-item-disabled'))"
        "  .map(e => e.dataset.testid).sort()"
    )
    check("only paste is offered on the background",
          disabled == ["deck-menu-copy", "deck-menu-cut", "deck-menu-delete",
                       "deck-menu-duplicate"],
          f"disabled={disabled}")
    await page.key("Escape", 27)
    await asyncio.sleep(SETTLE)
    check("escape closes the menu",
          await page.js("!document.querySelector('[data-testid=\"deck-context-menu\"]')"))

    # ── Ctrl+C / Ctrl+V ──────────────────────────────────────────────────────
    await page.reload()
    box = await page.rect(".deck-element", 4)
    await page.click(box["cx"], box["cy"])
    await asyncio.sleep(SETTLE)
    before = await page.js("window.__deck().slides[0].elements.length")
    await page.chord("c", "KeyC", 67)
    await asyncio.sleep(0.4)
    written = await page.js("window.__clipboard()")
    check("copy hands the system clipboard a deck payload",
          "opalatex.slides.elements" in (written or "") and '"shape": "rect"' in (written or ""),
          f"{len(written or '')} bytes, tagged={'opalatex.slides.elements' in (written or '')}")

    await page.chord("v", "KeyV", 86)
    await asyncio.sleep(0.8)
    pasted = await page.js("window.__deck().slides[0].elements")
    if not check("paste adds exactly one copy", len(pasted) == before + 1,
                 f"{before} -> {len(pasted)}"):
        return
    source = next(e for e in pasted if e["id"] == "thebox")
    copy = pasted[-1]
    check("the pasted element carries the original's properties",
          copy["type"] == source["type"] and copy["shape"] == source["shape"]
          and copy["fill"] == source["fill"] and copy["w"] == source["w"],
          f"shape={copy.get('shape')} fill={copy.get('fill')}")
    check("and does not land on top of it",
          (copy["x"], copy["y"]) != (source["x"], source["y"]),
          f"copy at ({copy['x']}, {copy['y']})")

    # Ctrl+V arms two paths — the browser's paste event and a timer that reads
    # the clipboard through the backend — and exactly one of them may paste.
    # Two deliberate pastes close together are what tells a guard that
    # de-duplicates per keystroke from one that merely de-duplicates per unit
    # of time: the second would have been eaten by the latter.
    before = len(pasted)
    await page.chord("v", "KeyV", 86)
    await asyncio.sleep(0.25)
    await page.chord("v", "KeyV", 86)
    await asyncio.sleep(1.0)
    twice = await page.js("window.__deck().slides[0].elements")
    check("two deliberate pastes land twice", len(twice) == before + 2,
          f"{before} -> {len(twice)}")

    # ── an image pasted from another application ─────────────────────────────
    # This is the one step that builds its own event, and deliberately so: no
    # DevTools command can put a *file* on a headless browser's clipboard, and
    # the local `/api/clipboard/read-image` endpoint belongs to the Python
    # server the harness does not run. What is under test here is not the input
    # — that is the previous step's job — but what the editor does with the
    # payload a real paste carries, and a `DataTransfer` holding a `File` is
    # exactly the object Chrome hands it.
    before = await page.js("window.__deck().slides[0].elements.length")
    await page.js("""
      (() => {
        // A 2x1 PNG, so the aspect ratio it produces is unmistakable.
        const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEklEQVR4nGP8z'
          + '8DwnwEJMCELAAAt7wMHrOM1JgAAAABJRU5ErkJggg==';
        const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));
        const file = new File([bytes], 'pasted.png', { type: 'image/png' });
        const data = new DataTransfer();
        data.items.add(file);
        document.body.focus();
        window.dispatchEvent(new ClipboardEvent('paste', {
          clipboardData: data, bubbles: true, cancelable: true,
        }));
        return true;
      })()
    """)
    await asyncio.sleep(1.0)
    elements = await page.js("window.__deck().slides[0].elements")
    if not check("a pasted image becomes an element", len(elements) == before + 1,
                 f"{before} -> {len(elements)}"):
        return
    image = elements[-1]
    check("the image is inlined into the deck",
          image["type"] == "image" and str(image.get("src", "")).startswith("data:image/"),
          f"type={image['type']} src={str(image.get('src', ''))[:24]}...")
    check("the image keeps its aspect ratio and stays selectable",
          abs(image["w"] / image["h"] - 2) < 0.35 and image["w"] <= 1280 * 0.6 + 1
          and image["w"] >= 32,
          f"{image['w']}x{image['h']} (a 2:1 source, floored to a usable size)")


async def check_presentation(page: Page, check: Checks) -> None:
    """A projected slide must fill the screen without spilling off it.

    Viewport units and `window.innerWidth` are the one pair of lengths the app's
    CSS zoom does not compensate; using either directly makes the slide exactly
    `uiScale` times too large. The corner shapes in the fixture are what such an
    overflow clips first — which is why this step reloads first: the gesture
    steps before it deliberately drag, rotate and resize elements, and one the
    suite itself pushed past the slide edge would be indistinguishable from one
    the presentation clipped.
    """
    await page.reload()

    # A formula is put on the slide first, because presentation mode is the
    # third surface that draws elements and the one nobody looks at until the
    # room is watching. It renders through the same component as the canvas,
    # which is the point: this is what proves the component really is shared.
    equation = await page.js(
        "(() => { const b = [...document.querySelectorAll('.deck-toolbar .deck-btn')]"
        "   .find(x => /Equa/.test(x.getAttribute('title') || ''));"
        "  if (!b) return null; const r = b.getBoundingClientRect();"
        "  return {x: r.left + r.width / 2, y: r.top + r.height / 2}; })()"
    )
    if equation:
        await page.click(equation["x"], equation["y"])
        await asyncio.sleep(0.4)
        await page.type_text("e^{i\\pi} + 1 = 0")
        await asyncio.sleep(0.2)
        await page.key("Enter", 13)
        await asyncio.sleep(0.6)

    button = await page.js(
        "(() => { const b = [...document.querySelectorAll('.deck-btn')]"
        "   .find(x => /Apresentar|Present/.test(x.textContent));"
        "  if (!b) return null; const r = b.getBoundingClientRect();"
        "  return {x: r.left + r.width / 2, y: r.top + r.height / 2}; })()"
    )
    if not check("present button found", button is not None):
        return
    await page.click(button["x"], button["y"])
    await asyncio.sleep(0.8)

    measured = await page.js(
        "(() => { const o = document.querySelector('.deck-present'); if (!o) return null;"
        "  const f = document.querySelector('.deck-present-frame');"
        "  const box = e => { const b = e.getBoundingClientRect();"
        "    return {l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height}; };"
        "  const els = [...document.querySelectorAll('.deck-present .deck-slide-view > div')];"
        "  const hud = document.querySelector('.deck-present-hud');"
        "  return {vw: innerWidth, vh: innerHeight, overlay: box(o), frame: box(f),"
        "          els: els.map(box), hud: hud && box(hud)}; })()"
    )
    if not check("presentation opens", measured is not None):
        return
    check("the projected slide draws the formula, not its source",
          await page.js("!!document.querySelector('.deck-present math')"))

    vw, vh = measured["vw"], measured["vh"]
    overlay, frame = measured["overlay"], measured["frame"]
    check("overlay covers the viewport exactly",
          abs(overlay["w"] - vw) < 2 and abs(overlay["h"] - vh) < 2,
          f"overlay={overlay['w']:.0f}x{overlay['h']:.0f} viewport={vw}x{vh}")
    check("slide fits inside the viewport",
          frame["r"] <= vw + 1 and frame["b"] <= vh + 1 and frame["l"] >= -1 and frame["t"] >= -1,
          f"frame l={frame['l']:.0f} t={frame['t']:.0f} r={frame['r']:.0f} b={frame['b']:.0f}")
    check("slide keeps its aspect ratio", abs(frame["w"] / frame["h"] - 16 / 9) < 0.02,
          f"ratio={frame['w'] / frame['h']:.4f}")
    check("slide is as large as it can be",
          abs(frame["w"] - vw) < 2 or abs(frame["h"] - vh) < 2,
          f"frame={frame['w']:.0f}x{frame['h']:.0f} viewport={vw}x{vh}")

    over_r = max((e["r"] - vw for e in measured["els"]), default=0.0)
    over_b = max((e["b"] - vh for e in measured["els"]), default=0.0)
    check("no element is clipped", over_r <= 1 and over_b <= 1,
          f"overflow right={over_r:.1f}px bottom={over_b:.1f}px")

    hud = measured["hud"]
    check("slide counter stays on screen",
          hud is not None and hud["r"] <= vw + 1 and hud["b"] <= vh + 1,
          f"hud right={hud and hud['r']:.0f} bottom={hud and hud['b']:.0f}")

    await page.cmd("Input.dispatchKeyEvent", {
        "type": "keyDown", "key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27,
    })
    await page.cmd("Input.dispatchKeyEvent", {
        "type": "keyUp", "key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27,
    })
    await asyncio.sleep(0.4)
    check("escape leaves the presentation",
          await page.js("!document.querySelector('.deck-present')"))



async def check_equation(page: Page, check: Checks) -> None:
    """Typing mathematics, with the slide itself as the preview.

    Everything here is a browser fact. Whether the field that opens with the
    equation takes the caret is focus behaviour; whether the formula on the
    slide follows the keystroke is a render path; and whether the box ends up
    fitted to the formula depends on measuring rendered MathML, which needs a
    layout engine and the math font actually loaded. A pure test can assert
    what the model stores and nothing about any of that.
    """
    await page.reload()

    button = await page.js(
        "(() => { const b = [...document.querySelectorAll('.deck-toolbar .deck-btn')]"
        "   .find(x => /Equa/.test(x.getAttribute('title') || ''));"
        "  if (!b) return null; const r = b.getBoundingClientRect();"
        "  return {x: r.left + r.width / 2, y: r.top + r.height / 2}; })()"
    )
    if not check("equation button found", button is not None):
        return

    before = await page.js("window.__deck().slides[0].elements.length")
    await page.click(button["x"], button["y"])
    await asyncio.sleep(0.5)

    opened = await page.js(
        "(() => ({field: !!document.querySelector('.deck-formula-input'),"
        "  focused: !!document.activeElement"
        "    && document.activeElement.className.includes('deck-formula-input'),"
        "  count: window.__deck().slides[0].elements.length}))()"
    )
    check("inserting an equation adds one element", opened["count"] == before + 1,
          f"{before} -> {opened['count']}")
    if not check("the formula field opens with the equation", opened["field"]):
        return
    check("the caret is in the formula field", opened["focused"])

    await page.type_text("\\frac{1}{2}")
    await asyncio.sleep(0.3)
    live = await page.js(
        "(() => ({rendered: !!document.querySelector('.deck-element .deck-equation math mfrac'),"
        "  stored: (window.__deck().slides[0].elements.slice(-1)[0] || {}).latex}))()"
    )
    check("the slide renders the formula as it is typed", live["rendered"])
    check("a half-typed formula is not written to the file", live["stored"] == "",
          f"stored={live['stored']!r}")

    await page.key("Enter", 13)
    await asyncio.sleep(0.6)

    stored = await page.js("window.__deck().slides[0].elements.slice(-1)[0]")
    check("the formula is stored as its LaTeX source",
          stored and stored["latex"] == "\\frac{1}{2}", f"latex={stored and stored['latex']!r}")
    check("the field closes when the formula is finished",
          await page.js("!document.querySelector('.deck-formula-input')"))

    fit = await page.js(
        "(() => { const eq = document.querySelector('.deck-element .deck-equation');"
        "  const m = eq && eq.querySelector('math'); if (!m) return null;"
        "  const b = eq.parentElement.getBoundingClientRect(), r = m.getBoundingClientRect();"
        "  return {bw: b.width, bh: b.height, mw: r.width, mh: r.height}; })()"
    )
    if not check("the committed formula is on the slide", fit is not None):
        return
    check("the formula fits inside its box",
          fit["mw"] <= fit["bw"] + 1 and fit["mh"] <= fit["bh"] + 1,
          f"math={fit['mw']:.0f}x{fit['mh']:.0f} box={fit['bw']:.0f}x{fit['bh']:.0f}")
    # The box is fitted to the formula, so what is left over is the padding —
    # not the 260-unit placeholder box the equation was inserted with.
    check("the box is fitted to the formula",
          0 <= fit["bw"] - fit["mw"] <= 45 and 0 <= fit["bh"] - fit["mh"] <= 45,
          f"slack {fit['bw'] - fit['mw']:.0f}x{fit['bh'] - fit['mh']:.0f}px")

    await asyncio.sleep(UNPAIR)
    where = await page.js(
        "(() => { const eq = document.querySelector('.deck-element .deck-equation');"
        "  const r = eq.parentElement.getBoundingClientRect();"
        "  return {cx: r.left + r.width / 2, cy: r.top + r.height / 2}; })()"
    )
    await page.double_click(where["cx"], where["cy"])
    await asyncio.sleep(0.4)
    reopened = await page.js(
        "(() => { const i = document.querySelector('.deck-formula-input');"
        "  return i ? i.value : null; })()"
    )
    check("double click reopens the formula it belongs to", reopened == "\\frac{1}{2}",
          f"field={reopened!r}")

    # Every prefix of a formula is invalid, so what the slide does with a draft
    # that does not compile is not an edge case — it is most keystrokes.
    await page.type_text(" + \\sqrt{")
    await asyncio.sleep(0.35)
    broken = await page.js(
        "(() => ({reported: !!document.querySelector('.deck-formula-error'),"
        "  kept: !!document.querySelector('.deck-element .deck-equation math mfrac'),"
        "  garbage: !!document.querySelector('.deck-element .deck-equation .katex-error')}))()"
    )
    check("an unfinished formula is reported in the field", broken["reported"])
    check("the slide keeps the last formula that compiled",
          broken["kept"] and not broken["garbage"],
          f"kept={broken['kept']} raw source on the slide={broken['garbage']}")

    await page.type_text("2}")
    await asyncio.sleep(0.3)
    await page.key("Enter", 13)
    await asyncio.sleep(0.6)
    finished = await page.js("window.__deck().slides[0].elements.slice(-1)[0]")
    check("finishing the formula replaces the one before it",
          finished and finished["latex"] == "\\frac{1}{2} + \\sqrt{2}",
          f"latex={finished and finished['latex']!r}")

    grown = await page.js("window.__deck().slides[0].elements.slice(-1)[0]")
    se = await page.rect(".deck-handle-se")
    if not check("the equation keeps its handles", se is not None):
        return
    await page.press(se["cx"], se["cy"])
    await page.move(se["cx"] + 40, se["cy"] + 40)
    await page.move(se["cx"] + 90, se["cy"] + 90)
    await asyncio.sleep(0.12)
    await page.release(se["cx"] + 90, se["cy"] + 90)
    await asyncio.sleep(0.7)

    after = await page.js("window.__deck().slides[0].elements.slice(-1)[0]")
    check("dragging a handle scales the formula, not the frame",
          after["fontSize"] > grown["fontSize"] and after["w"] > grown["w"],
          f"fontSize {grown['fontSize']} -> {after['fontSize']}, w {grown['w']} -> {after['w']}")
    ratio_before = grown["w"] / grown["h"]
    ratio_after = after["w"] / after["h"]
    # The box is fitted to the formula at both sizes, and its padding is a
    # fraction of the font size, so scaling one must not reshape the other.
    check("the scaled box still hugs the same formula",
          abs(ratio_after - ratio_before) < 0.04,
          f"aspect {ratio_before:.2f} -> {ratio_after:.2f}")



async def check_background(page: Page, check: Checks) -> None:
    """A slide background is a picture *behind* the slide, not over it.

    Two things only a browser can answer. Whether the layer actually paints
    under the elements — it is a real <img>, so a wrong stacking order would
    hide the whole slide — and whether it swallows the pointer: the canvas
    decides a press is on the background by testing `event.target`, so a layer
    that took the press would silently break click-to-deselect, and nothing in
    the pure suite can see that.
    """
    await page.reload()
    layer = await page.js(
        "(() => { const bg = document.querySelector('.deck-canvas .deck-background');"
        "  if (!bg) return null; const canvas = document.querySelector('.deck-canvas');"
        "  const r = bg.getBoundingClientRect(), c = canvas.getBoundingClientRect();"
        "  return {first: canvas.firstElementChild === bg,"
        "          events: getComputedStyle(bg).pointerEvents,"
        "          opacity: getComputedStyle(bg).opacity,"
        "          fit: getComputedStyle(bg).objectFit,"
        "          covers: Math.abs(r.width - c.width) < 2 && Math.abs(r.height - c.height) < 2,"
        "          loaded: bg.complete && bg.naturalWidth > 0}; })()"
    )
    if not check("the background layer renders", layer is not None):
        return
    check("the picture actually decoded", layer["loaded"])
    check("it is painted under every element", layer["first"])
    check("it covers the slide", layer["covers"])
    check("its opacity is the slide's", abs(float(layer["opacity"]) - 0.5) < 0.01,
          f"opacity={layer['opacity']}")
    check("it does not take the pointer", layer["events"] == "none",
          f"pointer-events={layer['events']}")

    # The behaviour that guard exists for: select something, then click bare
    # slide, and the selection must clear.
    element = await page.rect(".deck-element")
    await page.click(element["cx"], element["cy"])
    await asyncio.sleep(SETTLE)
    selected = await page.js("!!document.querySelector('.deck-selection')")
    await asyncio.sleep(UNPAIR)
    canvas = await page.rect(".deck-canvas")
    await page.click(canvas["x"] + canvas["w"] * 0.5, canvas["y"] + canvas["h"] * 0.28)
    await asyncio.sleep(SETTLE)
    cleared = await page.js("!document.querySelector('.deck-selection')")
    check("clicking the background still clears the selection", selected and cleared,
          f"selected={selected} cleared={cleared}")

    # The control that reaches all of this. It lives in the properties panel
    # when nothing is selected, which is when the slide is what the user is
    # working on -- and it did not exist at all until backgrounds did.
    controls = await page.js(
        "(() => { const labels = [...document.querySelectorAll('.deck-props label')]"
        "   .map(l => l.textContent.trim());"
        "  return {labels, colors: document.querySelectorAll('.deck-props .deck-color').length}; })()"
    )
    check("the slide background control is reachable",
          any("ackground" in text or "undo" in text for text in controls["labels"]),
          f"labels={controls['labels']}")


async def check_store_theme(page: Page, check: Checks) -> None:
    """Choosing a theme in the Asset Store and having it land in the deck.

    This is the one path that crosses two components neither of which can be
    checked alone: the store does not know what a presentation is, and the
    editor does not know the store exists. What only a browser can answer is
    whether the button reaches the deck at all — whether the picture arrives as
    something the canvas can draw, and whether the slide actually changes.
    """
    base = page.url.split(HARNESS_PATH)[0]
    await page.cmd("Page.navigate", {"url": f"{base}{STORE_PATH}"})
    deadline = time.time() + 30
    while time.time() < deadline:
        if await page.js("!!window.__ready && !!document.querySelector('.vscode-modal-tab')"):
            break
        await asyncio.sleep(0.2)
    await asyncio.sleep(0.5)

    tab = await page.js(
        "(() => { const b = [...document.querySelectorAll('.vscode-modal-tab')]"
        "   .find(x => /theme|Theme|Tema/.test(x.textContent));"
        "  if (!b) return null; const r = b.getBoundingClientRect();"
        "  return {x: r.left + r.width / 2, y: r.top + r.height / 2}; })()"
    )
    if not check("the store offers a themes tab", tab is not None):
        return
    await page.click(tab["x"], tab["y"])
    await asyncio.sleep(0.5)

    cards = await page.js("document.querySelectorAll('.background-card').length")
    if not check("the tab lists the themes", cards == 2, f"cards={cards}"):
        return
    # A theme with no picture must still show what it looks like, or half the
    # catalogue is unchoosable.
    check("a theme with no picture still previews its colours",
          await page.js("(() => { const p = document.querySelectorAll('.theme-card-preview')[0];"
                        "  return !!p && !p.querySelector('img')"
                        "    && getComputedStyle(p.children[0]).backgroundColor === 'rgb(52, 101, 164)'; })()"))
    # A theme that has a picture asks for its own. Whether those bytes decode is
    # a question for the server, and `tests/test_assetstore_themes.py` answers
    # it: an `<img src>` is a real network request, which the stubbed `fetch`
    # above deliberately does not intercept.
    previews = await page.js(
        "[...document.querySelectorAll('.theme-card-preview img')].map(i => i.getAttribute('src'))"
    )
    check("a theme with a picture previews that picture",
          previews == ["/api/assets/icon?id=blue-arcs"], f"src={previews}")

    before = await page.js("window.__deck().theme.headerHeight || 0")
    check("the deck starts with no theme chrome", before == 0, f"before={before}")

    button = await page.js(
        "(() => { const b = document.querySelector('.background-card .skill-card-action');"
        "  if (!b || b.disabled) return null; const r = b.getBoundingClientRect();"
        "  return {x: r.left + r.width / 2, y: r.top + r.height / 2}; })()"
    )
    if not check("the apply button is offered while a deck is open", button is not None):
        return
    await page.click(button["x"], button["y"])
    await asyncio.sleep(0.8)

    after = await page.js("window.__deck().theme")
    check("applying writes the theme into the deck", after.get("headerHeight") == 180,
          f"headerHeight={after.get('headerHeight')}")
    check("and marks the slide's title so it takes the theme colour",
          await page.js("window.__deck().slides[1].elements[0].role") == "title")
    check("the store says what it did",
          await page.js("!!document.body.textContent.match(/applied to|aplicado em/i)"))

    # The band has to reach the canvas, not just the file.
    await page.js("[...document.querySelectorAll('.deck-thumb')][1].click()")
    await asyncio.sleep(0.4)
    check("the slide behind the store is drawing the band",
          await page.js("!!document.querySelector('.deck-canvas .deck-chrome-header')"))
    check("and the footline",
          await page.js("(() => { const f = document.querySelector('.deck-canvas .deck-chrome-footer');"
                        "  return !!f && /Store test/.test(f.textContent); })()"))



async def check_packing(page: Page, check: Checks) -> None:
    """Packing the deck's pictures into the deck.

    The status strip offers this only when there is something to pack, which is
    the point: a referenced picture and an embedded one draw identically on the
    slide, so the count is the only way the user learns the file would not
    survive being sent. What only a browser can answer is whether the button
    appears at all, whether the fetch reaches the picture, and whether the
    result is one undoable edit rather than a rewrite the user cannot take back.
    """
    await page.reload()
    button = await page.js(
        "(() => { const b = [...document.querySelectorAll('.deck-status-btn')]"
        "   .find(x => /Pack|Empacotar/.test(x.textContent));"
        "  if (!b) return null; const r = b.getBoundingClientRect();"
        "  return {label: b.textContent, x: r.left + r.width / 2, y: r.top + r.height / 2}; })()"
    )
    if not check("the strip offers to pack what is external", button is not None):
        return
    check("and says how many", "1" in button["label"], f"label={button['label']!r}")

    before = await page.js("window.__element('external').src")
    check("the picture starts as a project reference", before == "figures/plot.png",
          f"src={before!r}")

    await page.click(button["x"], button["y"])
    await asyncio.sleep(1.0)
    after = await page.js("window.__element('external').src")
    check("packing embeds it into the deck", after.startswith("data:image/png;base64,"),
          f"src={after[:32]!r}")
    check("and the offer goes away", await page.js(
        "![...document.querySelectorAll('.deck-status-btn')]"
        ".some(x => /Pack|Empacotar/.test(x.textContent))"))
    check("the deck says what happened",
          await page.js("!!document.body.textContent.match(/packed|embutida/i)"))

    # One edit, not a rewrite: a user who did not mean it must be able to undo.
    await page.chord("z", "KeyZ", 90)
    await asyncio.sleep(0.5)
    check("packing is a single undoable edit",
          await page.js("window.__element('external').src") == "figures/plot.png")



# Chrome's own modifier bits, as `Input.dispatchKeyEvent` wants them.
ALT = 1
SHIFT = 8
# Ctrl and Shift together, which is the second spelling of redo.
CTRL_SHIFT = 2 | 8

DOWN, UP, LEFT, RIGHT, HOME, END = 40, 38, 37, 39, 36, 35
TAB, ENTER = 9, 13


async def check_bullets(page: Page, check: Checks) -> None:
    """A bulleted list: markers drawn from the model, and Tab indenting a line.

    This is the check that would have caught what the editor shipped with. Both
    defects live exactly where only a browser can see them:

      * the markers were characters in the text, so there was no style to
        change, no nesting, and a caret that could sit inside a bullet;
      * Tab moved focus out of the box — the browser's default action for it —
        which committed the edit and selected the element the author was
        typing in. Nothing about that is visible from a unit test: the key does
        not reach a handler at all.

    So the whole sequence is driven with real input, and every assertion is
    about what the user would see or what the file ends up holding.
    """
    await page.reload()
    await asyncio.sleep(SETTLE)

    markers = "[...document.querySelectorAll('%s .deck-bullet')].map(n => n.textContent)"
    drawn = await page.js(markers % ".deck-canvas")
    check("a list draws a marker per line", drawn == ["\u2022", "\u25e6", "\u2022"],
          f"markers={drawn}")

    stored = await page.js("window.__element('bullets').text")
    check("and the file holds words and tabs, not markers",
          "\u2022" not in stored and stored.count("\t") == 1, f"text={stored!r}")

    # Where the marker is *drawn*, which is the half a DOM assertion cannot
    # see. The list shipped once with every marker present in the markup and
    # none of them on the screen: `text-indent` is inherited, an inline-block
    # is a block container, so the marker applied the line's negative indent a
    # second time to its own glyph and landed outside the box, clipped.
    placed = await page.js(
        "(() => { const el = [...document.querySelectorAll('.deck-element')]"
        "   .find(e => e.querySelector('.deck-bullet'));"
        "  const box = el.getBoundingClientRect();"
        "  return [...el.querySelectorAll('.deck-bullet')].map(span => {"
        "    const r = document.createRange(); r.selectNodeContents(span);"
        "    const g = r.getBoundingClientRect();"
        "    const words = span.nextSibling ? (() => { const w = document.createRange();"
        "      w.selectNodeContents(span.parentElement.lastChild);"
        "      return w.getBoundingClientRect().left; })() : null;"
        "    return {left: g.left - box.left, width: g.width, right: g.right,"
        "            inside: g.left >= box.left - 0.5 && g.right <= box.right,"
        "            beforeWords: words === null || g.right <= words + 0.5}; }); })()"
    )
    check("every marker is drawn inside its box",
          bool(placed) and all(m["inside"] and m["width"] > 0 for m in placed),
          f"markers={placed}")
    check("and in front of the words, not on top of them",
          all(m["beforeWords"] for m in placed), f"markers={placed}")
    check("a sub-point's marker sits one indent further in",
          placed[1]["left"] > placed[0]["left"] + 1,
          f"level 0 at {placed[0]['left']:.1f}, level 1 at {placed[1]['left']:.1f}")

    levels = ("[...document.querySelectorAll('%s .deck-line')]"
              ".map(n => n.getAttribute('data-level'))")
    await asyncio.sleep(UNPAIR)
    box = await page.rect(".deck-element", 7)
    if not check("the list is where the fixture put it", box is not None):
        return
    await page.double_click(box["cx"], box["y"] + 20)
    await asyncio.sleep(0.3)
    if not check("double click opens the list for editing",
                 await page.js("!!document.querySelector('.deck-text-editing')")):
        return
    editing = await page.js(markers % ".deck-text-editing")
    check("the markers stay drawn while it is edited", editing == drawn, f"markers={editing}")

    # The caret into the last line, at the end of its words.
    await asyncio.sleep(UNPAIR)
    line = await page.rect(".deck-text-editing .deck-line", 2)
    await page.click(line["x"] + 30, line["cy"])
    await asyncio.sleep(0.15)
    await page.key("End", END)

    await page.key("Tab", TAB)
    await asyncio.sleep(0.2)
    check("Tab keeps the caret in the box it was typing in",
          await page.js("!!document.querySelector('.deck-text-editing')"))
    after = await page.js(levels % ".deck-text-editing")
    check("Tab indents the line the caret is in", after == ["0", "1", "1"], f"levels={after}")
    check("and its marker follows the level",
          (await page.js(markers % ".deck-text-editing")) == ["\u2022", "\u25e6", "\u25e6"])

    # Typing proves the caret is still where the author left it, which is the
    # difference between indenting a line and rebuilding the box under them.
    await page.type_text("!")
    await asyncio.sleep(0.15)

    await page.key("Enter", ENTER, text="\r")
    await page.type_text("Third")
    await asyncio.sleep(0.2)
    after = await page.js(levels % ".deck-text-editing")
    check("a new line starts at the level of the one it came from",
          after == ["0", "1", "1", "1"], f"levels={after}")

    await page.key("Tab", TAB, SHIFT)
    await asyncio.sleep(0.2)
    after = await page.js(levels % ".deck-text-editing")
    check("Shift+Tab moves it back out", after == ["0", "1", "1", "0"], f"levels={after}")

    await asyncio.sleep(UNPAIR)
    stage = await page.rect(".deck-stage")
    await page.click(stage["cx"], stage["bottom"] - 12)
    await asyncio.sleep(0.3)
    element = await page.js("window.__element('bullets')")
    check("the indents reach the file as tabs",
          element["text"] == "Point\n\tSub-point\n\tSecond!\nThird",
          f"text={element['text']!r}")
    check("and the box keeps its style", element["bullet"] == "disc",
          f"bullet={element['bullet']}")

    # The control the user reaches all of this through. A field the model can
    # carry and the panel cannot set is a bug that hides for months.
    await asyncio.sleep(UNPAIR)
    legacy = await page.js(
        "(() => { const els = [...document.querySelectorAll('.deck-element')];"
        "  const el = els.find(e => /Old point/.test(e.textContent));"
        "  if (!el) return null; const r = el.getBoundingClientRect();"
        "  return {cx: r.left + r.width / 2, cy: r.top + r.height / 2}; })()"
    )
    if not check("the legacy list is on the slide", legacy is not None):
        return
    await page.click(legacy["cx"], legacy["cy"])
    await asyncio.sleep(SETTLE)
    button = await page.js(
        "(() => { const b = [...document.querySelectorAll('.deck-props .deck-btn')]"
        "   .find(x => /^(Bulleted list|Lista com marcadores)$/.test(x.getAttribute('title') || ''));"
        "  if (!b) return null; const r = b.getBoundingClientRect();"
        "  return {x: r.left + r.width / 2, y: r.top + r.height / 2}; })()"
    )
    if not check("the list control is in the properties panel", button is not None):
        return
    await page.click(button["x"], button["y"])
    await asyncio.sleep(SETTLE)
    element = await page.js("window.__element('legacy')")
    check("the panel switches a box to a real list", element["bullet"] == "disc",
          f"bullet={element['bullet']}")
    # Switching the style on takes off the markers that were typed into the
    # text, or the box would draw a marker in front of a marker.
    check("and takes the typed markers off the text",
          element["text"] == "Old point\nOld sub-point", f"text={element['text']!r}")
    drawn = await page.js(
        "(() => { const el = [...document.querySelectorAll('.deck-element')]"
        "   .find(e => /Old point/.test(e.textContent));"
        "  return [...el.querySelectorAll('.deck-bullet')].map(n => n.textContent); })()"
    )
    check("which the canvas now draws instead", drawn == ["\u2022", "\u2022"],
          f"markers={drawn}")

    # What a paste does to the box. Markup arrives from a word processor as
    # blocks and inline tags that carry no level, and a select-all-and-type
    # leaves a bare text node where the lines were: the editor keeps the
    # browser's editing behaviour and repairs the shape afterwards, which is
    # the path this drives. `insertHTML` is how a paste lands, without needing
    # a system clipboard headless Chrome does not have.
    await asyncio.sleep(UNPAIR)
    await page.double_click(legacy["cx"], legacy["cy"])
    await asyncio.sleep(0.3)
    if not check("the list opens for editing",
                 await page.js("!!document.querySelector('.deck-text-editing')")):
        return
    await page.js(
        "document.execCommand('insertHTML', false,"
        " '<div>pasted one</div><div><b>pasted <i>two</i></b></div>')"
    )
    await asyncio.sleep(0.2)
    shape = await page.js(
        "(() => { const root = document.querySelector('.deck-text-editing');"
        "  return [...root.childNodes].map(n => n.nodeType === 1"
        "    ? n.className + ':' + n.getAttribute('data-level') : '#text'); })()"
    )
    check("pasted markup is repaired into lines",
          all(part.startswith("deck-line:") for part in shape), f"children={shape}")

    await page.type_text("!")
    await asyncio.sleep(0.15)
    await asyncio.sleep(UNPAIR)
    await page.click(stage["cx"], stage["bottom"] - 12)
    await asyncio.sleep(0.3)
    text = await page.js("window.__element('legacy').text")
    check("the words survive and the markup does not",
          "pasted one" in text and "pasted two" in text and "<" not in text,
          f"text={text!r}")
    check("and the caret stayed where the paste left it", text.rstrip().endswith("two!"),
          f"text={text!r}")


async def check_text_commands(page: Page, check: Checks) -> None:
    """What a typist expects of a text box: undo, redo, indent, bold.

    None of it is visible from a unit test. The window shortcuts are switched
    off while the caret is in a box, so every one of these keys either reaches
    the handler in `SlideCanvas` or reaches the browser — and what the browser
    does with them is precisely the defect being fixed: Ctrl+Z ran a native
    undo stack that this editor's own marker redraws had invalidated, and
    Ctrl+B wrapped the selection in a `<b>` the line reader drops on commit, so
    the bold showed while typing and vanished when the box closed.
    """
    await page.reload()
    await asyncio.sleep(SETTLE)

    editing = "!!document.querySelector('.deck-text-editing')"
    shown = "document.querySelector('.deck-text-editing')?.innerText ?? null"
    levels = ("[...document.querySelectorAll('.deck-text-editing .deck-line')]"
              ".map(n => n.getAttribute('data-level'))")

    await asyncio.sleep(UNPAIR)
    box = await page.rect(".deck-element", 7)
    if not check("the list is where the fixture put it", box is not None):
        return
    await page.double_click(box["cx"], box["y"] + 20)
    await asyncio.sleep(0.3)
    if not check("the box opens for typing", await page.js(editing)):
        return

    # Two characters typed as two keystrokes: one undo step, because a run of
    # ordinary typing coalesces until a pause or a boundary.
    for key, code in (("X", "KeyX"), ("Y", "KeyY")):
        await page.key(key, ord(key), text=key, code=code)
    await asyncio.sleep(0.2)
    check("typing lands in the box", (await page.js(shown)).endswith("XY"),
          f"box={await page.js(shown)!r}")

    await page.chord("z", "KeyZ", 90)
    await asyncio.sleep(0.2)
    check("Ctrl+Z takes back the run that was typed",
          (await page.js(shown)).endswith("Second"), f"box={await page.js(shown)!r}")
    check("and the caret stays in the box it was typing in", await page.js(editing))

    await page.chord("y", "KeyY", 89)
    await asyncio.sleep(0.2)
    check("Ctrl+Y puts it back", (await page.js(shown)).endswith("XY"),
          f"box={await page.js(shown)!r}")

    await page.chord("z", "KeyZ", 90)
    await asyncio.sleep(0.2)
    await page.key("z", 90, CTRL_SHIFT, code="KeyZ")
    await asyncio.sleep(0.2)
    check("Ctrl+Shift+Z is the other redo",
          (await page.js(shown) or "").endswith("XY"), f"box={await page.js(shown)!r}")

    # Undo across a structural edit, which is where the browser's own stack
    # gives up: pressing Enter adds a line and this editor then writes a marker
    # into it, and a script mutation is allowed to drop the native undo
    # transactions underneath. The box keeps its own history over the string
    # precisely so these two steps are still there.
    await page.key("Enter", ENTER, text="\r")
    await page.key("Z", ord("Z"), text="Z", code="KeyZ")
    await asyncio.sleep(0.25)
    check("a new bullet line takes its own marker",
          len(await page.js(levels)) == 4, f"levels={await page.js(levels)}")
    await page.chord("z", "KeyZ", 90)
    await asyncio.sleep(0.2)
    # The line survives and only the word on it goes: an empty line renders as
    # a break, so what says it is still there is the count, not the text.
    check("Ctrl+Z takes back the word on the new line",
          len(await page.js(levels)) == 4 and "Z" not in (await page.js(shown) or "Z"),
          f"lines={len(await page.js(levels))} box={await page.js(shown)!r}")
    await page.chord("z", "KeyZ", 90)
    await asyncio.sleep(0.2)
    check("and again takes back the line itself",
          (await page.js(shown) or "").endswith("XY")
          and len(await page.js(levels)) == 3, f"box={await page.js(shown)!r}")

    # Bold, while typing. It toggles the box the way the panel does — nothing
    # is inserted into the text, because a run of bold is not something the
    # format can carry (spec §13) and showing one until the box closes is worse
    # than not offering it.
    await page.chord("b", "KeyB", 66)
    await asyncio.sleep(0.25)
    check("Ctrl+B bolds the box being typed in",
          (await page.js("window.__element('bullets').bold")) is True)
    check("and the box is still open", await page.js(editing))
    check("with no markup left in it",
          await page.js("!document.querySelector('.deck-text-editing b,"
                        " .deck-text-editing strong')"))

    # The indent command, from the panel, with the caret in the last line.
    await asyncio.sleep(UNPAIR)
    line = await page.rect(".deck-text-editing .deck-line", 2)
    await page.click(line["x"] + 30, line["cy"])
    await asyncio.sleep(0.15)
    button = await page.js(
        "(() => { const b = [...document.querySelectorAll('.deck-props .deck-btn')]"
        "   .find(x => /^(Increase indent|Aumentar recuo)/.test(x.getAttribute('title') || ''));"
        "  if (!b) return null; const r = b.getBoundingClientRect();"
        "  return {x: r.left + r.width / 2, y: r.top + r.height / 2}; })()"
    )
    if not check("the indent command is in the properties panel", button is not None):
        return
    await page.click(button["x"], button["y"])
    await asyncio.sleep(0.25)
    check("the indent button moves the line the caret is in",
          await page.js(levels) == ["0", "1", "1"], f"levels={await page.js(levels)}")
    check("without closing the box", await page.js(editing))

    # Out of the box, and the same command with nothing being typed: the whole
    # box is the only sensible target then, and it is how a list is moved in
    # one gesture.
    await asyncio.sleep(UNPAIR)
    stage = await page.rect(".deck-stage")
    await page.click(stage["cx"], stage["bottom"] - 12)
    await asyncio.sleep(0.3)
    check("the indent reached the file", "\tSecond" in
          (await page.js("window.__element('bullets').text")),
          f"text={await page.js('window.__element(\'bullets\').text')!r}")

    await asyncio.sleep(UNPAIR)
    await page.click(box["cx"], box["y"] + 20)
    await asyncio.sleep(SETTLE)
    before = await page.js("window.__element('bullets').text")
    await page.click(button["x"], button["y"])
    await asyncio.sleep(0.25)
    after = await page.js("window.__element('bullets').text")
    check("with nothing being typed, it indents the whole box",
          after == "\n".join("\t" + line for line in before.split("\n")),
          f"{before!r} -> {after!r}")

    # Ctrl+Z with nothing left in the box hands the keystroke to the deck's own
    # history, which is where that indent now lives.
    await asyncio.sleep(UNPAIR)
    await page.double_click(box["cx"], box["y"] + 20)
    await asyncio.sleep(0.3)
    await page.chord("z", "KeyZ", 90)
    await asyncio.sleep(0.3)
    check("Ctrl+Z past the start of the edit closes the box",
          await page.js(f"!({editing})"))
    check("and undoes the change before it",
          await page.js("window.__element('bullets').text") == before,
          f"text={await page.js('window.__element(\'bullets\').text')!r}")


async def check_text_properties(page: Page, check: Checks) -> None:
    """The type controls: a field the model carries and the panel cannot set is
    a field nobody has. Font, line spacing and vertical alignment were exactly
    that until this suite grew a check for them."""
    await page.reload()
    await asyncio.sleep(SETTLE)
    await asyncio.sleep(UNPAIR)
    box = await page.rect(".deck-element", 7)
    await page.click(box["cx"], box["y"] + 20)
    await asyncio.sleep(SETTLE)

    for title, expected in (
        ("Centre vertically|Centralizar verticalmente", "middle"),
        ("Align to the bottom|Alinhar embaixo", "bottom"),
    ):
        target = await page.js(
            "(() => { const b = [...document.querySelectorAll('.deck-props .deck-btn')]"
            f"   .find(x => new RegExp('^({title})$').test(x.getAttribute('title') || ''));"
            "  if (!b) return null; const r = b.getBoundingClientRect();"
            "  return {x: r.left + r.width / 2, y: r.top + r.height / 2}; })()"
        )
        if not check(f"the vertical {expected} control is in the panel", target is not None):
            continue
        await asyncio.sleep(UNPAIR)
        await page.click(target["x"], target["y"])
        await asyncio.sleep(SETTLE)
        written = await page.js("window.__element('bullets').valign")
        check(f"it writes valign={expected} to the file", written == expected,
              f"valign={written}")

    # The two selects, driven by the keyboard: a closed `<select>` changes its
    # value on an arrow key and fires the same `change` a mouse would.
    for title, field in (("Font|Fonte", "fontFamily"), ("Line spacing|Espaçamento entre linhas", "lineHeight")):
        found = await page.js(
            "(() => { const s = [...document.querySelectorAll('.deck-props select')]"
            f"   .find(x => new RegExp('^({title})$').test(x.getAttribute('title') || ''));"
            "  if (!s) return null; const r = s.getBoundingClientRect();"
            "  return {x: r.left + r.width / 2, y: r.top + r.height / 2,"
            "          options: s.options.length}; })()"
        )
        if not check(f"the {field} control is in the panel", found is not None,
                     f"options={found and found['options']}"):
            continue
        before = await page.js(f"window.__element('bullets').{field}")
        # Focused through the DOM and changed with a real arrow key. A click
        # would open the dropdown, which is a browser widget rather than page
        # content and swallows the keys that follow it in headless Chrome —
        # the keystroke is the part that has to be real, and it is.
        await page.js(
            "[...document.querySelectorAll('.deck-props select')]"
            f"  .find(x => new RegExp('^({title})$').test(x.getAttribute('title') || ''))"
            "  .focus()"
        )
        await page.key("ArrowDown", DOWN)
        await asyncio.sleep(0.3)
        after = await page.js(f"window.__element('bullets').{field}")
        check(f"choosing another {field} writes it to the file", after != before,
              f"{before!r} -> {after!r}")


async def check_rail_keyboard(page: Page, check: Checks) -> None:
    """The thumbnail rail must be navigable without a mouse.

    Only a browser can answer this, and one thing in particular: the arrows are
    bound *twice* in this editor — in the rail they move between slides, on the
    canvas they nudge the selected element — and which binding a key reaches is
    decided by where focus is. A unit test can call either handler and prove
    nothing about the pair. The case that matters is the last one below: an
    element is selected on the canvas, focus is in the rail, and the arrows must
    move the slide and leave the element exactly where it was.
    """
    await page.reload()
    await asyncio.sleep(SETTLE)

    async def new_slide():
        button = await page.js(
            "(() => { const b = [...document.querySelectorAll('.deck-toolbar .deck-btn')]"
            "   .find(x => /Novo slide|New slide/.test(x.textContent));"
            "  if (!b) return null; const r = b.getBoundingClientRect();"
            "  return {x: r.left + r.width / 2, y: r.top + r.height / 2}; })()"
        )
        if not button:
            return False
        await page.click(button["x"], button["y"])
        await asyncio.sleep(SETTLE)
        return True

    if not check("new slide button found", await new_slide() and await new_slide()):
        return

    current = ("[...document.querySelectorAll('.deck-thumb')]"
               ".findIndex(el => el.classList.contains('is-current'))")
    focused = ("[...document.querySelectorAll('.deck-thumb')]"
               ".indexOf(document.activeElement)")
    count = "document.querySelectorAll('.deck-thumb').length"

    total = await page.js(count)
    if not check("three slides in the rail", total == 3, f"thumbs={total}"):
        return

    # One Tab stop, not one per slide: a deck of forty slides must not put forty
    # stops between the toolbar and the canvas.
    stops = await page.js("document.querySelectorAll('.deck-thumb[tabindex=\"0\"]').length")
    check("the rail is a single tab stop", stops == 1, f"tabbable thumbs={stops}")

    first = await page.rect(".deck-thumb")
    await page.click(first["cx"], first["cy"])
    await asyncio.sleep(SETTLE)
    check("clicking a thumbnail focuses it", await page.js(focused) == 0,
          f"activeElement index={await page.js(focused)}")

    await page.key("ArrowDown", DOWN)
    await asyncio.sleep(0.15)
    check("ArrowDown moves to the next slide", await page.js(current) == 1,
          f"current={await page.js(current)}")
    check("focus follows the selection", await page.js(focused) == 1,
          f"activeElement index={await page.js(focused)}")

    await page.key("ArrowRight", RIGHT)
    await asyncio.sleep(0.15)
    check("ArrowRight also means next", await page.js(current) == 2,
          f"current={await page.js(current)}")

    await page.key("ArrowDown", DOWN)
    await asyncio.sleep(0.15)
    check("the last slide is the end of the list", await page.js(current) == 2,
          f"current={await page.js(current)}")

    await page.key("Home", HOME)
    await asyncio.sleep(0.15)
    check("Home goes to the first slide", await page.js(current) == 0,
          f"current={await page.js(current)}")

    await page.key("End", END)
    await asyncio.sleep(0.15)
    check("End goes to the last slide", await page.js(current) == 2,
          f"current={await page.js(current)}")

    # Reordering, the keyboard's counterpart of dragging a thumbnail.
    ids = "window.__deck().slides.map(s => s.id).join(',')"
    before = await page.js(ids)
    await page.key("ArrowUp", UP, ALT)
    await asyncio.sleep(0.3)
    after = await page.js(ids)
    moved = before.split(",")
    moved[1], moved[2] = moved[2], moved[1]
    check("Alt+Arrow reorders the deck", after == ",".join(moved),
          f"before={before} after={after}")
    check("the moved slide stays current", await page.js(current) == 1,
          f"current={await page.js(current)}")

    # The binding that shares its keys with the canvas.
    await page.key("Home", HOME)
    await asyncio.sleep(0.2)
    await asyncio.sleep(UNPAIR)
    title = await page.rect(".deck-element")
    await page.click(title["cx"], title["cy"])
    await asyncio.sleep(SETTLE)
    selected = await page.js("document.querySelectorAll('.deck-handle').length > 0")
    if not check("an element is selected on the canvas", selected):
        return
    x_before = await page.js("window.__deck().slides[0].elements[0].x")

    thumb = await page.rect(".deck-thumb", 0)
    await page.click(thumb["cx"], thumb["cy"])
    await asyncio.sleep(SETTLE)
    await page.key("ArrowDown", DOWN)
    await asyncio.sleep(0.2)
    x_after = await page.js("window.__deck().slides[0].elements[0].x")
    check("an arrow in the rail moves the slide, not the element",
          await page.js(current) == 1 and x_after == x_before,
          f"current={await page.js(current)} x {x_before} -> {x_after}")


# Presentation runs last: it takes over the screen, and everything before it
# needs the editor visible.
SUITE = (
    check_layout,
    check_arrows,
    check_selection,
    check_text_editing,
    check_drag,
    check_rotation,
    check_border,
    check_clipboard,
    check_equation,
    check_background,
    check_packing,
    check_store_theme,
    check_bullets,
    check_text_commands,
    check_text_properties,
    check_rail_keyboard,
    check_presentation,
)


async def run_scale(devtools_url: str, base_url: str, scale: str) -> Checks:
    check = Checks()
    url = f"{base_url}{HARNESS_PATH}?uiScale={scale}"
    async with websockets.connect(devtools_url, max_size=20_000_000) as ws:
        page = Page(ws, url)
        await page.cmd("Page.enable")
        await page.cmd("Runtime.enable")
        try:
            await page.reload()
        except TimeoutError:
            check("harness loads", False, "the editor never mounted")
            return check

        for step in SUITE:
            try:
                await step(page, check)
            except Exception as error:  # one broken step must not hide the rest
                check(step.__name__, False, f"raised {type(error).__name__}: {error}")
    return check


def main(argv: list[str]) -> int:
    headful = "--headful" in argv
    scales = [a for a in argv if not a.startswith("-")] or ["1", "1.4"]

    chrome = find_chrome()
    vite_port, cdp_port = free_port(), free_port()
    base_url = f"http://localhost:{vite_port}"

    vite = subprocess.Popen(
        ["npx", "vite", "--port", str(vite_port), "--strictPort"],
        cwd=GUI_SRC, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
    )
    browser = None
    try:
        wait_for(f"{base_url}{HARNESS_PATH}")
        browser = subprocess.Popen(
            [chrome, *([] if headful else ["--headless"]),
             "--disable-gpu", "--no-sandbox", "--no-first-run", "--hide-scrollbars",
             f"--remote-debugging-port={cdp_port}",
             f"--window-size={WINDOW[0]},{WINDOW[1]}", "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
        )
        wait_for(f"http://127.0.0.1:{cdp_port}/json")
        targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{cdp_port}/json"))
        devtools_url = next(t for t in targets if t["type"] == "page")["webSocketDebuggerUrl"]

        failures = 0
        for scale in scales:
            check = asyncio.run(run_scale(devtools_url, base_url, scale))
            check.report(f"interface scale {scale}")
            failures += check.failed
        if failures:
            print(f"\n{failures} check(s) failed")
            return 1
        print("\nall browser checks passed")
        return 0
    finally:
        for process in (browser, vite):
            if process and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
