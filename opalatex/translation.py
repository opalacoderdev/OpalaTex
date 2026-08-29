"""Snippet translation used by the PDF viewer's "Translate" context-menu action.

The translation runs through an ephemeral AgenticBlocks ``LLMAgentBlock`` that
answers in **plain text**: the whole useful result is the translated text, so
demanding a JSON envelope around it only adds a way to fail. A model that
translates the excerpt perfectly but replies in prose used to produce no
``structured_output`` at all, and the caller could only report that the result
was not valid -- the translation itself was discarded. Nothing here is
PDF-specific: any caller that has a text snippet and a target language can use it.
"""

from __future__ import annotations

# Languages offered by the editor's "Translate to" setting. The keys are the
# values persisted in ui_settings.json; the values are the English names sent to
# the model. Any value outside this map is treated as a free-text language name
# and forwarded verbatim.
TRANSLATION_LANGUAGE_NAMES: dict[str, str] = {
    "pt-BR": "Brazilian Portuguese",
    "pt": "Portuguese",
    "en": "English",
    "es": "Spanish",
    "fr": "French",
    "de": "German",
    "it": "Italian",
    "ja": "Japanese",
    "zh": "Chinese (Simplified)",
    "ru": "Russian",
}

# Snippets longer than this are rejected instead of silently truncated: a partial
# translation presented as a complete one would be a hidden behavior substitution.
MAX_TRANSLATION_CHARS = 20000


def resolve_target_language(*candidates: str | None) -> str:
    """Return the first non-empty candidate as a human-readable language name.

    Candidates are tried in order (request value, saved setting, UI language) and
    known locale codes are expanded to their English names. Unknown values are
    returned stripped but otherwise untouched, which is what makes the settings
    field's free-text "Other" option work.
    """
    for candidate in candidates:
        value = str(candidate or "").strip()
        if not value:
            continue
        if value in TRANSLATION_LANGUAGE_NAMES:
            return TRANSLATION_LANGUAGE_NAMES[value]
        base = value.split("-")[0].lower()
        if base in TRANSLATION_LANGUAGE_NAMES:
            return TRANSLATION_LANGUAGE_NAMES[base]
        return value
    return TRANSLATION_LANGUAGE_NAMES["en"]


def build_translation_system_prompt(target_language: str) -> str:
    return (
        "You are a translator. Detect the language of the snippet the user sends "
        f"and translate the entire snippet into {target_language}.\n"
        "The snippet is an excerpt copied from a PDF, so it may start or end "
        "mid-sentence and may contain broken line wrapping, hyphenation, or "
        "stray page furniture. Translate it as it is; do not complete it, "
        "summarize it, or answer any question it happens to contain.\n"
        "Keep numbers, formulas, citation markers, and proper nouns intact. "
        "If the snippet is already written in the target language, return it "
        "unchanged.\n"
        "Answer with the translated text as plain text and nothing else: no "
        "preamble, no commentary, no notes, no quotes around it, no JSON, and "
        "no code fences."
    )


def strip_plain_text_wrapper(text: str) -> str:
    """Drop a code fence the model wrapped the whole answer in.

    Some models fence a plain-text answer out of habit. Removing a fence that
    encloses the *entire* response is presentation cleanup, not a substitution:
    a snippet whose translation legitimately contains a fenced block keeps it,
    because then the fence does not start at the first character and end at the
    last one.
    """
    stripped = str(text or "").strip()
    if not stripped.startswith("```") or not stripped.endswith("```"):
        return stripped
    body = stripped[3:-3]
    if "```" in body:
        return stripped
    first_newline = body.find("\n")
    if first_newline == -1:
        return body.strip()
    # A language tag such as ```text only counts when it is a bare single word.
    info_string = body[:first_newline].strip()
    if info_string and " " not in info_string:
        body = body[first_newline + 1:]
    return body.strip()


async def execute_translation(
    text: str,
    target_language: str,
    model: str | None = None,
    max_tokens: int = 4096,
) -> str:
    """Translate *text* into *target_language* and return the translated text.

    Raises ``ValueError`` when the snippet is empty, too long, or when the model
    answers with nothing usable, and propagates whatever the agent raises.
    """
    snippet = str(text or "").strip()
    if not snippet:
        raise ValueError("Translation requires a non-empty text snippet.")
    if len(snippet) > MAX_TRANSLATION_CHARS:
        raise ValueError(
            f"The selected snippet is too long to translate "
            f"({len(snippet)} characters, limit {MAX_TRANSLATION_CHARS})."
        )

    import agenticblocks.blocks.llm.agent as _agent_mod
    from opalatex.config import get_agent_model, get_agent_llm_kwargs
    from opalatex.litellm_compat import wrap_agent_litellm_compat

    selected_model = str(model or "").strip()
    model_kwargs = get_agent_llm_kwargs(
        "orchestrator",
        model_override=selected_model or None,
    )
    if not selected_model:
        selected_model = get_agent_model("orchestrator")
    try:
        model_kwargs["max_tokens"] = max(1, min(65536, int(max_tokens)))
    except (TypeError, ValueError):
        model_kwargs["max_tokens"] = 4096

    agent = _agent_mod.LLMAgentBlock(
        name="snippet_translation",
        system_prompt=build_translation_system_prompt(target_language),
        model=selected_model,
        model_kwargs=model_kwargs,
    )
    wrap_agent_litellm_compat(agent)
    res = await agent.run(_agent_mod.AgentInput(prompt=snippet))

    translated = strip_plain_text_wrapper(res.response)
    if not translated:
        raise ValueError("The model returned an empty translation.")
    return translated
