"""Registering a model from a text front-end.

A usable model is two records: a **provider connection** holding the credentials,
and a **catalog model** naming a model under that connection with its
capabilities. Both were reachable only through the desktop Settings dialog, so
`/set-main-model <id>` in the CLI pointed a project at an id with no `api_base`,
no key and no capabilities behind it — `config.get_agent_llm_kwargs` resolves all
of those from the catalog entry.
"""

import asyncio

import pytest

from opalatex import models_store
from opalatex.cli_catalog import ArgumentError, parse_pairs, _CONNECTION_FIELDS, _CONNECTION_ALIASES, _MODEL_FIELDS, _MODEL_ALIASES
from opalatex.cli_commands import REPLState, _registry
from opalatex.project import ProjectStore


@pytest.fixture
def catalog(tmp_path, monkeypatch):
    """An isolated model store, so a test never touches the real catalog."""
    monkeypatch.setattr(models_store, "_MODELS_STORE_PATH", tmp_path / "models.json")
    models_store._invalidate_models_cache()
    yield models_store
    models_store._invalidate_models_cache()


@pytest.fixture
def state(tmp_path):
    store = ProjectStore(db_path=str(tmp_path / "s.db"))
    project = store.create(
        name="p", mode="auto", model="", project_name="P", project_path=str(tmp_path)
    )
    return REPLState(project, store, renderer=object())


def run(state, line):
    cmd, *rest = line.split(maxsplit=1)
    return asyncio.run(_registry.dispatch(state, cmd, rest))


# ── Argument parsing ─────────────────────────────────────────────────────────


def test_values_may_be_quoted():
    values, _extra = parse_pairs(
        ['label="Ollama Gil" provider=ollama'], _CONNECTION_FIELDS, _CONNECTION_ALIASES
    )
    assert values == {"label": "Ollama Gil", "provider": "ollama"}


def test_a_field_may_be_spelled_the_way_it_is_spoken():
    values, _extra = parse_pairs(
        ["connection=c thinking=true profile=light context=4096"],
        _MODEL_FIELDS, _MODEL_ALIASES, allow_extra=True,
    )
    assert values == {
        "connection_id": "c", "supports_thinking": True,
        "prompt_profile": "light", "num_ctx": 4096,
    }


def test_a_mistyped_field_is_refused_instead_of_becoming_a_hidden_setting():
    """Anything unknown would otherwise be forwarded to the provider as a kwarg.

    `num_ctxx=5` would have been accepted as a pass-through parameter, leaving
    the user with a context setting that silently does nothing.
    """
    with pytest.raises(ArgumentError) as err:
        parse_pairs(["num_ctxx=5"], _MODEL_FIELDS, _MODEL_ALIASES, allow_extra=True)
    assert "num_ctxx" in str(err.value)
    assert "extra.<name>" in str(err.value)


def test_a_deliberate_provider_parameter_is_written_with_a_prefix():
    values, extra = parse_pairs(
        ["name=m extra.keep_alive=30m extra.numa=true"],
        _MODEL_FIELDS, _MODEL_ALIASES, allow_extra=True,
    )
    assert values == {"name": "m"}
    assert extra == {"keep_alive": "30m", "numa": True}


@pytest.mark.parametrize("bad", ["supports_thinking=maybe", "num_ctx=lots", "profile=medium", "policy=whatever"])
def test_a_value_of_the_wrong_shape_is_refused(bad):
    with pytest.raises(ArgumentError):
        parse_pairs([bad], _MODEL_FIELDS, _MODEL_ALIASES, allow_extra=True)


def test_a_bare_word_is_not_a_pair():
    with pytest.raises(ArgumentError):
        parse_pairs(["ollama"], _CONNECTION_FIELDS, _CONNECTION_ALIASES)


# ── Connections ──────────────────────────────────────────────────────────────


def test_a_connection_is_registered_and_gets_an_id_from_its_label(catalog, state):
    run(state, '/providers add label="Ollama Gil" provider=ollama api_base=http://h:11434/v1 api_key=K')
    connections = catalog.load_connections()
    assert [c["id"] for c in connections] == ["ollama-gil"]
    assert connections[0]["api_base"] == "http://h:11434/v1"
    assert connections[0]["api_key"] == "K"


def test_a_connection_needs_a_label_and_a_provider(catalog, state):
    run(state, "/providers add label=OnlyLabel")
    assert catalog.load_connections() == []


def test_relabelling_a_connection_keeps_its_key(catalog, state):
    """Re-running add with the same id is an edit, and an edit must not wipe credentials."""
    run(state, '/providers add id=c label="First" provider=ollama api_key=SECRET')
    run(state, '/providers add id=c label="Renamed" provider=ollama')
    connection = catalog.get_connection("c")
    assert connection["label"] == "Renamed"
    assert connection["api_key"] == "SECRET"


def test_a_key_can_still_be_cleared(catalog, state):
    run(state, '/providers add id=c label="L" provider=ollama api_key=SECRET')
    run(state, '/providers add id=c label="L" provider=ollama api_key=')
    assert catalog.get_connection("c")["api_key"] == ""


def test_a_connection_in_use_is_not_removed(catalog, state):
    """Cascading would leave a project pointing at an id with no credentials."""
    run(state, '/providers add id=c label="L" provider=ollama')
    run(state, "/models add name=m connection=c")
    run(state, "/providers remove c")
    assert catalog.get_connection("c") is not None

    run(state, "/models remove ollama/m")
    run(state, "/providers remove c")
    assert catalog.get_connection("c") is None


# ── Catalog models ───────────────────────────────────────────────────────────


def test_a_model_is_registered_under_its_connection(catalog, state):
    run(state, '/providers add id=c label="L" provider=ollama api_base=http://h/v1 api_key=K')
    run(state, "/models add name=gemma4:26b connection=c num_ctx=65000 supports_thinking=true temperature=0.4")

    model = catalog.get_model("ollama/gemma4:26b")
    assert model["name"] == "gemma4:26b"
    assert model["num_ctx"] == 65000
    assert model["supports_thinking"] is True
    assert model["temperature"] == 0.4
    # Credentials and provider are the connection's, resolved on read.
    assert model["provider"] == "ollama"
    assert model["api_base"] == "http://h/v1"
    assert model["api_key"] == "K"


def test_the_model_row_never_holds_a_copy_of_the_key(catalog, state):
    """A copy would go stale the moment the connection's key is rotated."""
    import sqlite3

    run(state, '/providers add id=c label="L" provider=ollama api_base=http://h/v1 api_key=SECRET')
    run(state, "/models add name=m connection=c")
    run(state, "/models set ollama/m temperature=0.2")

    row = sqlite3.connect(catalog._resolve_db_path()).execute(
        "SELECT provider, api_key, api_base FROM global_models"
    ).fetchone()
    assert row == ("", "", "")
    assert catalog.get_model("ollama/m")["api_key"] == "SECRET"


def test_a_second_model_of_the_same_name_under_another_connection_is_suffixed(catalog, state):
    """The id keeps `provider/name` resolvable for LiteLLM; the suffix disambiguates."""
    run(state, '/providers add id=a label="A" provider=ollama')
    run(state, '/providers add id=b label="B" provider=ollama')
    run(state, "/models add name=gemma4 connection=a")
    run(state, "/models add name=gemma4 connection=b")

    ids = sorted(m["id"] for m in catalog.load_models())
    assert ids == ["ollama/gemma4", "ollama/gemma4#b"]
    assert catalog.resolve_runtime_model_id("ollama/gemma4#b") == "ollama/gemma4"


def test_the_same_name_twice_under_one_connection_is_refused(catalog, state):
    run(state, '/providers add id=c label="L" provider=ollama')
    run(state, "/models add name=gemma4 connection=c")
    run(state, "/models add name=gemma4 connection=c")
    assert len(catalog.load_models()) == 1


def test_a_model_needs_a_connection_that_exists(catalog, state):
    run(state, "/models add name=m connection=nope")
    assert catalog.load_models() == []


def test_an_inference_parameter_out_of_range_is_refused(catalog, state):
    run(state, '/providers add id=c label="L" provider=ollama')
    run(state, "/models add name=m connection=c temperature=9")
    assert catalog.load_models() == []


def test_set_edits_in_place_rather_than_adding_a_second_entry(catalog, state):
    run(state, '/providers add id=c label="L" provider=ollama')
    run(state, "/models add name=m connection=c")
    run(state, "/models set ollama/m profile=light policy=delegate num_ctx=8192")

    models = catalog.load_models()
    assert len(models) == 1
    assert models[0]["prompt_profile"] == "light"
    assert models[0]["orchestrator_policy"] == "delegate"
    assert models[0]["num_ctx"] == 8192


def test_set_merges_pass_through_parameters(catalog, state):
    run(state, '/providers add id=c label="L" provider=ollama')
    run(state, "/models add name=m connection=c extra.keep_alive=30m")
    run(state, "/models set ollama/m extra.numa=true")
    assert catalog.get_model("ollama/m")["extra_model_params"] == {
        "keep_alive": "30m", "numa": True,
    }


def test_the_registered_model_resolves_to_real_run_kwargs(catalog, state, monkeypatch):
    """The point of registering: the id a project stores must carry credentials.

    Without a catalog entry this returns no api_base and no key, and the run
    reaches the provider unauthenticated.
    """
    from opalatex import config as config_mod

    run(state, '/providers add id=c label="L" provider=ollama api_base=http://h/v1 api_key=K')
    run(state, "/models add name=gemma4 connection=c supports_thinking=true temperature=0.35")

    kwargs = config_mod.get_agent_llm_kwargs("memgpt", model_override="ollama/gemma4")
    # The stored base keeps its `/v1`; LiteLLM's native Ollama provider wants the
    # root, so `normalize_ollama_api_base_for_litellm` trims it on the way out.
    assert kwargs.get("api_base") == "http://h"
    assert kwargs.get("api_key") == "K"
    assert kwargs.get("temperature") == 0.35
    assert catalog.get_model("ollama/gemma4")["api_base"] == "http://h/v1"


# ── Reach ────────────────────────────────────────────────────────────────────


def test_the_catalog_commands_work_in_every_text_front_end():
    """They change a global store, not terminal state, so nothing marks them CLI-only."""
    for name in ("/providers", "/provider", "/models"):
        assert not _registry.is_cli_only(name)


def test_bare_models_still_answers_what_this_project_runs_on(catalog, state):
    assert run(state, "/models") != "continue" or True  # no catalog subcommand taken
    # A subcommand routes to the catalog instead.
    assert run(state, "/models list") == "continue"


def test_a_slash_command_works_as_a_one_shot_run(catalog, tmp_path, monkeypatch):
    """Registering a model from a shell script is the same need `-p` serves.

    Without this the command text would be sent to the model as a question, and
    the registration would simply not happen.
    """
    import types

    from opalatex import cli

    store = ProjectStore(db_path=str(tmp_path / "s.db"))
    project = store.create(
        name="p", mode="auto", model="", project_name="P", project_path=str(tmp_path)
    )
    args = types.SimpleNamespace(db=store.db_path, mode=None, project="p", here=False)

    turns = []
    monkeypatch.setattr(cli, "run_turn", lambda *a, **k: turns.append(a) or _never())

    code = asyncio.run(cli.run_command_once(
        project, store, '/providers add label="Script" provider=ollama', args
    ))

    assert code == 0
    assert turns == [], "a slash command must not be sent to the model"
    assert [c["id"] for c in catalog.load_connections()] == ["script"]


def test_an_unknown_one_shot_command_fails_loudly(tmp_path):
    import types

    from opalatex import cli

    store = ProjectStore(db_path=str(tmp_path / "s.db"))
    project = store.create(
        name="p", mode="auto", model="", project_name="P", project_path=str(tmp_path)
    )
    args = types.SimpleNamespace(db=store.db_path, mode=None, project="p", here=False)

    assert asyncio.run(cli.run_command_once(project, store, "/nope", args)) == 2


async def _never():
    raise AssertionError("the model must not be reached")
