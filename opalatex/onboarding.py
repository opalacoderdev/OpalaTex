import os
import json

OPALATEX_DIR = os.path.join(os.path.expanduser("~"), ".opalatex")
ONBOARDING_FILE = os.path.join(OPALATEX_DIR, "onboarding.json")

def is_onboarding_completed() -> bool:
    """Return whether the onboarding wizard has been completed."""
    if not os.path.exists(ONBOARDING_FILE):
        return False
    try:
        with open(ONBOARDING_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data.get("completed", False)
    except Exception:
        return False

def complete_onboarding() -> bool:
    """Mark the onboarding wizard as completed."""
    os.makedirs(OPALATEX_DIR, exist_ok=True)
    try:
        with open(ONBOARDING_FILE, "w", encoding="utf-8") as f:
            json.dump({"completed": True}, f, indent=4)
        return True
    except Exception:
        return False


PILOT_SKILL_NAME = "tutorial_opalatex"


def pilot_skill_content(lang: str = "pt") -> str:
    """The instructor SKILL.md installed into a pilot project.

    Generated from ``opalatex/guides/tutorial.<lang>.md`` instead of a hardcoded copy,
    so the pilot skill and the built-in tutorial chat cannot drift apart and start
    telling the user two different things. The previous hardcoded blobs had already
    drifted: they advertised ``/goal`` and ``/grill-me``, which the chat orchestrator
    does not implement.
    """
    from .tutorial import load_guide, normalize_lang

    lang = normalize_lang(lang)
    if lang == "en":
        description = "A built-in interactive tutorial to teach new users how to use OpalaTex."
        intro = (
            "# OpalaTex Instructor\n\n"
            "You are the official OpalaTex guide for this user, who has just installed "
            "the application. Welcome them warmly and teach them how OpalaTex works "
            "whenever they ask.\n\n"
            "Answer from the guide below — it is authoritative for anything about "
            "OpalaTex itself. Keep answers short, use Markdown, and say plainly when a "
            "question is not covered here.\n\n"
            "If the user's first message is generic (\"Hi\", \"What do I do here?\", "
            "\"Help\"), introduce yourself as the OpalaTex guide and offer to walk them "
            "through registering a provider and a model, which is the first thing they "
            "need.\n"
        )
    else:
        description = "Um tutorial interativo embutido para ensinar os novos usuários a utilizarem o OpalaTex."
        intro = (
            "# Instrutor do OpalaTex\n\n"
            "Você é o guia oficial do OpalaTex para este usuário, que acabou de instalar "
            "a aplicação. Receba-o de forma acolhedora e ensine como o OpalaTex funciona "
            "sempre que ele perguntar.\n\n"
            "Responda a partir do guia abaixo — ele é a fonte autoritativa para qualquer "
            "coisa sobre o próprio OpalaTex. Mantenha as respostas curtas, use Markdown "
            "e diga claramente quando uma pergunta não estiver coberta aqui.\n\n"
            "Se a primeira mensagem do usuário for genérica (\"Oi\", \"O que eu faço "
            "aqui?\", \"Ajuda\"), apresente-se como o guia do OpalaTex e ofereça ajuda "
            "para cadastrar um provedor e um modelo, que é a primeira coisa de que ele "
            "precisa.\n"
        )

    return (
        "---\n"
        f"name: {PILOT_SKILL_NAME}\n"
        f"description: {description}\n"
        "---\n\n"
        f"{intro}\n"
        f"{load_guide(lang).strip()}\n"
    )
