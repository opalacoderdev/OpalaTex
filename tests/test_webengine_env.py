"""Tests for the graphics mode handed to the embedded QtWebEngine window."""

import pytest

from opalatex.webengine_env import (
    CHROMIUM_FLAGS_VAR,
    DISABLE_GPU_FLAG,
    DISABLE_GPU_VAR,
    GPU_AUTO,
    GPU_OFF,
    apply_webengine_environment,
    normalize_gpu_mode,
    resolve_gpu_mode,
)


def test_unknown_values_fall_back_to_using_the_gpu():
    assert normalize_gpu_mode(None) == GPU_AUTO
    assert normalize_gpu_mode("") == GPU_AUTO
    assert normalize_gpu_mode("nonsense") == GPU_AUTO
    assert normalize_gpu_mode("OFF") == GPU_OFF
    # A hand-edited or older settings file that wrote a boolean still means "off".
    assert normalize_gpu_mode(True) == GPU_OFF


def test_the_environment_overrides_the_saved_setting_in_both_directions():
    settings = {"webengine_gpu": GPU_AUTO}
    assert resolve_gpu_mode({DISABLE_GPU_VAR: "1"}, settings) == (GPU_OFF, "env")

    settings = {"webengine_gpu": GPU_OFF}
    assert resolve_gpu_mode({DISABLE_GPU_VAR: "0"}, settings) == (GPU_AUTO, "env")
    assert resolve_gpu_mode({}, settings) == (GPU_OFF, "settings")
    assert resolve_gpu_mode({}, {}) == (GPU_AUTO, "default")


def test_turning_the_gpu_off_adds_the_flag_on_any_platform():
    env = {}
    report = apply_webengine_environment(env, "win32", {"webengine_gpu": GPU_OFF})
    assert env[CHROMIUM_FLAGS_VAR] == DISABLE_GPU_FLAG
    assert report["gpu_mode"] == GPU_OFF
    assert report["source"] == "settings"
    assert report["reason"]


def test_using_the_gpu_leaves_windows_untouched():
    env = {}
    report = apply_webengine_environment(env, "win32", {"webengine_gpu": GPU_AUTO})
    assert CHROMIUM_FLAGS_VAR not in env
    assert report["changed"] is False


def test_user_supplied_flags_are_never_dropped():
    env = {CHROMIUM_FLAGS_VAR: "--enable-logging --v=1"}
    apply_webengine_environment(env, "win32", {"webengine_gpu": GPU_OFF})
    assert env[CHROMIUM_FLAGS_VAR].split() == ["--enable-logging", "--v=1", DISABLE_GPU_FLAG]

    # Applying it twice must not accumulate duplicates.
    apply_webengine_environment(env, "win32", {"webengine_gpu": GPU_OFF})
    assert env[CHROMIUM_FLAGS_VAR].split().count(DISABLE_GPU_FLAG) == 1


def test_linux_keeps_its_historic_default_and_its_escape_hatch():
    env = {}
    apply_webengine_environment(env, "linux", {})
    assert env[CHROMIUM_FLAGS_VAR] == DISABLE_GPU_FLAG

    chosen = {CHROMIUM_FLAGS_VAR: "--use-gl=desktop"}
    apply_webengine_environment(chosen, "linux", {})
    assert chosen[CHROMIUM_FLAGS_VAR] == "--use-gl=desktop"
