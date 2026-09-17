"""The Qt floor declares what was verified, not what happens to install.

`PyQt6>=6.8.0` was declared for a long time and was false on Windows in two
different ways, both found by installing the older releases while chasing a
graphics crash:

* Qt 6.8.2 embeds Chromium 122. pdf.js 5 calls ``URL.parse`` (Chrome 126), so
  opening a PDF threw and the whole window went grey.
* Qt 6.10.2 ships ``MSVCP140.dll`` 14.26. ``onnxruntime`` needs a newer C++
  runtime and brings none; Qt loads first, its runtime wins for the whole
  process, and the first agent message died importing onnxruntime.

6.11.2 passes both. The ``-Qt6`` packages are the ones that carry the runtime,
so they are held to the verified patch release rather than to PyQt6's own
``>=6.11.0``. Lowering any of these needs the same two checks run again.
"""

import re
import tomllib
from pathlib import Path

from packaging.requirements import Requirement
from packaging.version import Version

ROOT = Path(__file__).resolve().parent.parent

VERIFIED = {
    "pyqt6": Version("6.11.0"),
    "pyqt6-qt6": Version("6.11.2"),
    "pyqt6-webengine": Version("6.11.0"),
    "pyqt6-webengine-qt6": Version("6.11.2"),
}


def _floors(lines):
    floors = {}
    for line in lines:
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        req = Requirement(line)
        name = re.sub(r"[-_.]+", "-", req.name).lower()
        if name in VERIFIED:
            mins = [Version(s.version) for s in req.specifier if s.operator in (">=", "==")]
            floors[name] = max(mins) if mins else None
    return floors


def _requirements_txt():
    return _floors((ROOT / "requirements.txt").read_text(encoding="utf-8").splitlines())


def _pyproject():
    data = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    return _floors(data["project"]["dependencies"])


def test_every_qt_package_is_declared_with_a_floor_in_both_files():
    for source, floors in (("requirements.txt", _requirements_txt()), ("pyproject.toml", _pyproject())):
        assert set(floors) == set(VERIFIED), f"{source} must declare all of {sorted(VERIFIED)}"
        assert all(floors.values()), f"{source} declares a Qt package without a floor"


def test_the_floor_is_never_below_the_verified_release():
    for source, floors in (("requirements.txt", _requirements_txt()), ("pyproject.toml", _pyproject())):
        for name, verified in VERIFIED.items():
            assert floors[name] >= verified, (
                f"{source}: {name}>={floors[name]} is below the verified {verified}; "
                "see this module's docstring for what broke below it"
            )


def test_both_files_agree():
    """The snap installs from pyproject.toml, a checkout from requirements.txt."""
    assert _requirements_txt() == _pyproject()
