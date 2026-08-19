# OpalaTex — Quick usage guide

Welcome to **OpalaTex**, a LaTeX editor with an integrated AI assistant. Everything
runs on your machine: LaTeX is compiled locally with Tectonic, and the AI runs either
on a local Ollama model or on a provider you configure with your own API key. There is
no account, no billing, and no cloud service owned by OpalaTex.

This chat is your tutorial. Pick a question from the menu below and I will answer it
right away — no model needs to be configured for that. Once you have registered a
model, you can also just type your own questions here: I keep this whole guide in
memory for this conversation.

## overview :: How does OpalaTex work?

OpalaTex has three parts working together:

1. **The editor** — source editor with a PDF preview side by side, SyncTeX to jump
   between the PDF and the `.tex` line that produced it, plus a rich-text mode, a
   markdown preview, dedicated document viewers (.docx, .pptx, HTML), and a file
   explorer.
2. **The AI assistant** — a chat orchestrator that reads and edits your files, runs
   commands, searches the web, generates office documents (.docx, .pptx), asks
   interactive clarifying questions, and delegates specialised tasks to skills and
   templates from the **Asset Store**.
3. **Local compilation** — Tectonic compiles your document without requiring a
   system-wide LaTeX installation.

The usual workflow is:

- create or import a project (a project is one folder);
- register a provider connection and a model in Settings, then select the model in the
  chat toolbar;
- ask the assistant for what you need in the chat, or install skills/templates from the
  **Asset Store**;
- compile and inspect the PDF;
- review the assistant's changes in **Review** mode before keeping them.

The assistant runs in one of three **modes**, selectable in the chat toolbar:

- **auto** — full autonomy; it executes tools without asking at each step;
- **plan** — it may not modify anything; it gathers context and proposes a structured plan
  for you to approve first;
- **edit** — it edits files directly, but asks for confirmation before running terminal
  commands.

## projects :: How do I create and configure a project?

A project is a folder on your disk plus the metadata OpalaTex stores for it (selected
models, mode, chats, memory, shadow Git checkpoints).

- **New project** — the "New Project" dialog asks for a name, a parent folder, and
  optionally an initial model. Only one project per folder is allowed.
- **Import project** — point OpalaTex at an existing folder that already contains your
  `.tex` sources.

Two things surprise new users, and both are deliberate:

- **A project starts with no model configured.** OpalaTex never picks a model for you.
  Until you select one, the assistant refuses to run and tells you to choose a model —
  it does not quietly fall back to some default.
- **Selecting no model is a valid state.** You can clear the selection in Project
  Settings and return to an unconfigured project.

Projects store references to models by catalog ID (`<provider>/<name>`). Global
credentials (API keys and base URLs) belong to the global model catalog, so rotating an
API key in Settings updates every project automatically without re-entering credentials.

## project-settings :: What are all the project settings and parameters?

Project settings are edited through the Project Settings dialog (gear icon in the
sidebar) and are organised into three tabs:

### 1. General Tab (`geral`)

- **Internal ID & Display Name** — `Internal ID` is the permanent database key; `Display
  Name` is the title shown in the interface.
- **Project Path & Main File** — the absolute folder on disk and the entrypoint `.tex`
  file used as the root for compilation (e.g. `main.tex`).
- **LaTeX Compile on Save** — choose between `Disabled`, `Partial` (fast chapter/file
  compilation), or `Full` (recompiles the entire document on every save).
- **User Git Root** — optional custom path to an external Git repository if your source
  control root is located outside the project folder.
- **Mode** — `auto`, `plan`, or `edit`.
- **Description** — optional project summary provided to the assistant as high-level
  context.
- **Share Core Memory** — when checked, all chats in this project share a single
  persistent core memory. When unchecked, each chat maintains its own independent memory.
- **Force Vision** — forces multimodal/image payloads to be sent to both orchestrator and
  worker models, even when provider capability autodetection is conservative.
- **Load Contextual Skills** — button that scans the project directory for custom
  `.opalatex/skills` and registers them into the project.

### 2. Orchestrator & Worker Tabs

A project configures separate models and runtime settings for the **Orchestrator** (the
conversational agent) and the **Worker** (ephemeral sub-agents spawned by `run_skill`).
Both tabs offer:

- **Model Selection & Hardware Monitor** — select from registered models. Real-time GPU
  VRAM and system RAM indicators show model suitability (green = fits comfortably, yellow
  = may be slow, red = risks VRAM overflow).
- **Sampling & LiteLLM Parameters**:
  - `temperature` (0.0 to 2.0) — controls creativity vs determinism.
  - `max_tokens` — maximum output tokens per completion.
  - `num_ctx` — context window size in tokens. **Crucial for local models!**
  - `seed` — integer for deterministic sampling.
  - `top_p`, `top_k`, `min_p`, `frequency_penalty`, `presence_penalty`, `repetition_penalty`.
  - `reasoning_effort` — (`none`, `low`, `medium`, `high`, `xhigh`) for reasoning models
    supporting effort scaling (e.g. o1, o3, Gemini, Claude).
  - `thinking` — enables chain-of-thought reasoning tokens (for Ollama, automatically
    remaps to `ollama_chat/` for streaming reasoning).
  - `stream` — enables real-time token streaming.
- **Agent Runtime Parameters**:
  - `max_heartbeats` — maximum consecutive tool iterations per turn.
  - `max_context_tokens` — context budget ceiling before summarization.
  - `eviction_threshold` — fraction of context (default `0.85`) at which older turns are
    condensed into a running summary.
  - `memory_pressure_threshold` — threshold for aggressive memory compaction.
  - `loop_detection` & `loop_detection_limit` (default `3`) — tracks identical tool calls
    with identical arguments and blocks repeats before execution, breaking infinite loops.
  - **`empty_response_reasoning_fallback`** (*Use Thinking When the Response Is Empty*) —
    when enabled, if a reasoning model puts its entire answer into the reasoning/thinking
    channel and leaves the visible response channel empty, OpalaTex publishes the
    reasoning content as the final answer instead of failing or spending extra turns
    asking the model to repeat itself.
  - `response_mode` — `last` (visible final response only) or `all`.
  - `debug` — enables verbose agent execution logs.
  - Worker-specific limits: `max_iterations` and `max_tool_calls`.

## providers :: How do I register a provider and a model?

Registration is a **two-step catalog**, so you type your credentials once and reuse
them for every model that shares them.

**Step 1 — register a provider connection** (Settings → Edit Models → Manage
Connections → Add):

- **Label** — a name for you, e.g. "OpenRouter (personal)".
- **Provider** — the LiteLLM provider slug: `ollama`, `openai`, `gemini`,
  `anthropic`, `mistral`, `groq`, `together_ai`, `openrouter`, …
- **API key** — your own key. It stays on your machine.
- **API base URL** — only when the provider needs one. Examples: local Ollama uses
  `http://localhost:11434/v1`; Ollama Cloud uses `https://ollama.com`; OpenRouter uses
  `https://openrouter.ai/api/v1`.

**Step 2 — register a model against that connection** (Settings → Edit Models → Add):

- **Name** — the model name exactly as the provider spells it, e.g.
  `qwen2.5-coder:7b`, `gpt-5.5`, `gemini-2.5-pro`.
- **Connection** — pick the connection you created; the credentials come from it.
- **Capabilities** — see the "models" topic below.

The model then appears in the catalog with the id `<provider>/<name>`. That id is what
projects store, and it never changes when you edit the connection's credentials — so
rotating an API key does not break any project.

Two useful shortcuts:

- **Import local Ollama models** — one button in Edit Models queries your running
  Ollama at `http://127.0.0.1:11434/api/tags` and registers everything it finds.
- **Deleting a connection that still has models is refused.** That is intentional: a
  project must never point at a model whose credentials cannot be resolved.

## models :: Orchestrator, worker, and model capabilities

A project uses **two model roles**:

- **Orchestrator** — the model you talk to in the chat. It plans, calls tools, and
  writes the final answers. Give it your best model.
- **Worker** — the model used by ephemeral skill sub-agents (`run_skill`). Workers do
  narrow, tool-heavy jobs and terminate quickly, so a smaller/faster model is fine and
  usually preferable.

When you register a model in the catalog you can declare capabilities:

- **`supports_thinking`** — the model accepts a thinking/reasoning parameter. OpalaTex
  only sends `think` when this is enabled. Thinking is on by default for the
  orchestrator and off by default for workers, because a worker stuck in a reasoning
  loop blocks a tool call; the orchestrator's reasoning is visible and useful to you.
  For an `ollama/` model with thinking enabled, OpalaTex switches to `ollama_chat/`
  internally so reasoning can stream natively.
- **`requires_single_system_message`** — some chat templates (seen with an
  Ollama-served qwen3.8) reject a request with more than one `system` message, with the
  error `system message must be at the beginning`. Enable this flag for such a model
  and OpalaTex merges all system messages into one leading message for it — and only
  for it.
- **`prompt_profile`** (`full` or `light`) — how much prompt text the model receives.
  `full` delivers the complete guardrails, instructions and examples; `light` delivers a
  condensed version (same rules, less prose) that saves tokens and latency.
- **Orchestrator writes** (`direct` or `delegate`) — whether this model, **when it is the
  orchestrator**, may touch files. On `direct` it creates and edits them itself with
  `write_file`, `write_content_pos` and `replace_content_range`. On `delegate` it only
  reads: every create, edit, rename or delete has to go through a worker via `run_skill`.
  As a worker the model writes normally — the setting has no effect in that role, because
  a worker has nobody to delegate to.
- **`num_ctx`** — optional catalog-level context window override for this model.

Prompt profile and orchestrator writes are **two independent settings**: the first says
how much text the model reads, the second says what it is allowed to do. All four
combinations are valid.

### Which combination to use

A new model defaults to `full` + `direct`, which is the behavior OpalaTex has always
shipped. Tune it according to the project's two models:

| Your setup | Prompt profile | Orchestrator writes |
| --- | --- | --- |
| Small local model everywhere (orchestrator and worker) | `light` | `direct` |
| Large model as orchestrator, small one as worker | `full` | `delegate` |
| Large model in both roles (cloud) | `full` | `direct` |
| Small model as orchestrator, large one as worker | `light` | `delegate` |

Why each row:

- **Small everywhere → short prompt, direct writes.** A small model follows a short
  prompt better, and delegating here only swaps one small model for another: you pay an
  extra round-trip plus a sub-agent that starts with no memory at all, and gain no
  capability. For a one-line edit, the direct path makes fewer mistakes.
- **Large + small → full prompt, delegated writes.** This is where delegation actually
  pays off. The large model is good at exactly what is left for it: reading, locating the
  precise range, and writing an unambiguous instruction. And the file content — usually
  the bulk of a turn — ends up in the worker's context instead of the orchestrator's,
  which is the expensive one and the one you want to preserve across the conversation.
- **Large everywhere → full prompt, direct writes.** Context is plentiful and quality is
  not the bottleneck; fewer round-trips means faster answers.
- **Small orchestrator, large worker → short prompt, delegated writes.** Here delegation
  exists to take editing away from the weaker model and hand it to the stronger one.

Two caveats about `delegate`:

- It needs **at least one active skill** to work. `command-line` is active out of the box
  and fills that role; if no skill is available, the assistant tells you it cannot write
  instead of trying and failing.
- It costs one extra model call per change. If small edits feel slow, this is the first
  setting to reconsider.

You'll find it in **Edit Models**, in the model form right below the prompt profile, and
as a column in the models list.

## settings :: Which settings should I use?

**Context window (`num_ctx`)** — this is the single most important setting for local
models. The number you set is the real cap, regardless of what the model advertises: a
"128K model" runs at whatever `num_ctx` your project sets. Size it against your VRAM
(see the local-models topic). The chat's context indicator measures against this value,
shows how much of the window is consumed, and reports the tokens the provider actually
charged, not an estimate.

**Mode** — start in **auto** for everyday work. Use **plan** when you want to review
what the assistant intends to do before it touches anything, and **edit** for quick,
targeted fixes.

**Streaming** — leave it on. You see the answer as it is produced, and you can
interrupt a run that is going the wrong way.

**Loop-detection limit** — default `3`. When the assistant repeats the same tool call
with the same arguments this many times, the repeat is blocked before it executes and
the model is told to change its approach. Lower it if a small local model tends to spin;
raise it only if you have a legitimate repetitive workflow.

**Eviction threshold** — default `0.85`. Older turns start being summarised out of the
working context once the window is 85% full, rather than waiting for it to overflow.

**Thinking & Reasoning Fallback** — leave thinking off unless the model's documentation
confirms support. If you use a reasoning model locally (such as DeepSeek-R1 or Qwen
thinking variants) and find that it sometimes leaves the response blank, enable
`empty_response_reasoning_fallback` in Project Settings.

**Skills** — activate only what you need. Every active skill adds its description to the
system prompt, which costs context on every single turn.

## asset-store :: How do the Asset Store, skills, and templates work?

The **Asset Store** (Store icon in the ActivityBar) is your hub for extending OpalaTex
with reusable skills and LaTeX document templates.

### 1. Skills (`Skills` tab)

Skills are markdown instruction packages (with optional scripts) that teach the AI
specialised capabilities.

- **Catalog sub-tab** — browse and install skills from the repository into your
  project (`<project>/.opalatex/skills/<name>/`).
- **Active in project sub-tab** — toggle skills on or off for the current project.
- **Local copies and updates** — when a project-local skill is installed, it shadows any
  bundled version of the same name. If the catalog version is updated, the Asset Store
  detects the drift and shows an **"Update local copy"** button. If you want to revert to
  the built-in version, click **"Restore bundled"**.

### 2. LaTeX Templates (`LaTeX templates` tab)

Templates provide complete starting document structures (articles, theses, books,
beamer presentations, CVs).

- **One-click installation** — templates unpack directly at your project root.
- **Conflict detection & safety** — if any template file already exists in your project,
  OpalaTex detects the conflict, warns you, lists the conflicting files, and asks for
  explicit confirmation before overwriting anything.

## local-models :: Tips for local models (Ollama)

Running locally is free and private, and it works well when you respect the limits.

- **Ollama 0.30.5 or newer.** Older builds do not support tool calls properly, and
  tool calls are how the assistant reads and edits your files.
- **Choose a model that actually supports tool calling.** A model without it can chat
  but cannot do anything in your project. Qwen2.5-Coder and similar tool-capable
  families are the safe choice.
- **Size `num_ctx` against your VRAM, not against ambition.** A context that does not
  fit in VRAM spills to system RAM and the model becomes unusably slow. Rough starting
  points: ~8 GB VRAM → a 7B model at 8K–16K context; ~12–16 GB → a 7B–14B model at
  16K–32K; less than 6 GB → a 3B model, and treat it as a way to try the interface
  rather than to do real work.
- **With small models in both roles, use the `light` profile and `direct` writes.** The
  short prompt is easier to follow, and delegating between two small models adds a
  round-trip without adding capability. If the orchestrator is a large model and the
  worker a small one, the recommendation flips to `full` + `delegate`. See the table in
  the models topic.
- **Use a smaller worker model than the orchestrator.** Workers are tool executors;
  they do not need the reasoning quality you want in the chat.
- **Keep thinking off for workers.** A local reasoning model given a complex input can
  loop for a very long time inside a tool call.
- **Enable `empty_response_reasoning_fallback`** if your local reasoning model writes
  its output into the thinking channel instead of the response channel.
- **Keep the active skill set small.** Each one costs context on every turn.
- **Be realistic.** Small local models are excellent for short edits, formatting, and
  learning the interface. They struggle with long documents, large data, and
  multi-step refactors — which is what the cloud models topic is about.

## local-skills :: Which skills suit small local models?

Skills are markdown instruction files that teach the assistant a specialised job. The
assistant delegates to them with `run_skill`, which spawns a fresh, stateless sub-agent.
For a small local model, prefer skills that turn a big job into a **script** instead of
into a long conversation:

- **`command-line`** — the workhorse. Terminal commands, build scripts, Python
  snippets, bulk file operations. When a job is large, a small model does far better
  writing a ten-line Python script and running it than reasoning over the data itself.
- **`log-table-condenser`** — for large logs and tables (`.jsonl`, `.csv`, `.tsv`,
  `.log`). It streams and condenses the file instead of loading it into the context
  window. Use it whenever a data file is bigger than a few hundred lines.
- **`latex-assistant`** — explains compiler errors and generates LaTeX fragments and
  mathematics. Short, well-bounded prompts, which is exactly what small models handle
  well.

Seeing what you have open takes no skill at all: the assistant already reads your open
tabs, the focused file, and the selected text through the native `get_editor_state` tool.
Say "this file" or "the selected text" and it will know what you mean.

Rules of thumb for small models:

- activate two or three skills, not all of them;
- prefer surgical edits (`search_code` → `read_content_pos` →
  `replace_content_range`) over asking for a whole rewritten file — long tool-call JSON
  gets truncated by output limits;
- if the same skill fails twice in a row, stop and change the approach; OpalaTex
  detects that and will tell the assistant to stop redelegating.

## tools-features :: What tools and features are available (documents, web search, questions)?

Beyond basic LaTeX file editing, OpalaTex includes powerful built-in tools and capabilities:

- **Native Document Exporters (`create_docx_file`, `create_pptx_file`)** — the assistant
  can generate formatted Microsoft Word (`.docx`) and PowerPoint (`.pptx`) presentations
  natively, complete with styled headings, tables, bullet lists, and embedded images.
- **Live Web Search** — the assistant can search the web in real-time to look up CTAN
  package documentation, LaTeX error solutions, bibtex citations, or library syntax.
- **Human-in-the-Loop Clarifications (`ask_question`)** — when the assistant needs
  clarification, preference choices, or column selections, it triggers an interactive
  modal (`AskModal`) in the UI, letting you pick options or write in responses without
  breaking the flow.
- **Safe Confirmations** — potentially destructive actions and plan executions prompt a
  clean confirmation modal before proceeding.
- **Surgical Text Editing** — `search_code`, `read_content_pos`, `replace_content_range`,
  and `write_content_pos` allow the AI to locate and modify precise line spans without
  reading or rewriting huge files. The last two only edit a file that already exists; a
  new file is always created with `write_file`.
- **Attachments & Multimodal Input** — drag and drop images, PDFs, text, or data files
  into the chat. OpalaTex automatically extracts text from documents or forwards images to
  vision-capable models.
- **Diagnostic Activity & Thoughts** — expandable "AI Thoughts" blocks on assistant
  messages let you inspect the model's reasoning trace without cluttering the final text.

## cloud-for-big-data :: When should I use cloud models?

**When your problem involves a large amount of data, use a cloud model.** This is the
single most useful piece of advice in this guide.

Large documents, long logs, big datasets, whole-project refactors, and long multi-step
tasks need a large context window and a model that gets tool calls right the first
time. A small local model in that situation will fill its window, start evicting the
conversation, produce malformed tool calls, and burn far more of your time than the API
call would have cost.

Two good options, both configured exactly like any other provider:

- **Ollama Cloud** — the same Ollama you already know, with the models running on
  their infrastructure. Register a connection with provider `ollama`, API base
  `https://ollama.com`, and your key; model names carry a `:cloud` suffix. OpalaTex
  recognises those ids and applies a 65K context window by default. This is the
  smallest step up if you are already using local Ollama.
- **API providers** — **OpenRouter** gives you one key and one connection for models
  from many vendors, which makes it easy to switch models without re-registering
  credentials (provider slug `openrouter`, API base `https://openrouter.ai/api/v1`).
  Gemini, OpenAI, Anthropic, Mistral, Groq and Together AI are also supported directly.

A practical hybrid that works well: keep a local model as the **worker** for cheap
mechanical steps, and use a cloud model as the **orchestrator** for the reasoning. You
can change either one from the chat toolbar at any moment, without touching the project.

## context :: How does the context window work here?

The chat header shows a context indicator. It reports the tokens the provider actually
charged for the request — not a character-count guess — and it measures against the
effective window (`num_ctx`), which is the real cap regardless of what the model
advertises. The number is how much is **consumed**, and the bar drains as the window
fills.

Two behaviours follow from that, and both are intentional:

- **`read_file` refuses a file that does not fit the remaining budget.** It tells you
  the file size, the budget left, and the paging path to use instead. An oversized read
  is unrecoverable: it would land in the history, the provider would truncate the
  request from the front, and the assistant would end up answering a question it can no
  longer see.
- **`read_content_pos` pages through a large file** and always says so when it returns
  less than you asked for, including the exact call to resume with. The normal recipe
  for a big file is `search_code` to find the line numbers, then `read_content_pos` for
  just that range.

When the window fills anyway, the oldest turns are summarised into a running summary
rather than dropped — and the turn in progress is never evicted.

## compile-git :: Compiling, the PDF, and reviewing changes

**Compiling** — Tectonic compiles locally; no system LaTeX installation is needed. You
get a full compile, a partial compile (a single chapter or file), and a fast single-pass
draft for quick checks. Compilation errors can be pasted at the assistant, or fixed
straight from the problems panel.

**PDF and SyncTeX** — the preview sits next to the source, and SyncTeX maps a place in
the PDF back to the `.tex` line that produced it.

**Checkpoints and Review mode** — every agent turn is wrapped in shadow-Git
checkpoints: one before it runs, one after. If the turn changed nothing, both are
discarded. If it did change something, **Review** mode shows that turn as a single row
whose diff is the whole start-to-end change, so you can see exactly what the assistant
did and undo it if you disagree. Regular Git (your own commits, branches, history) is
available in the Source Control sidebar and is entirely separate from those checkpoints.

## chat-memory :: Chats, memory, and editing messages

**Multiple chats** — a project can hold many conversations. Each one has its own
history and its own working context, so a long debugging session does not pollute the
chat where you are writing your paper. Create one with the `+` in the chat sidebar.

**Memory** — the assistant keeps persistent facts in *core memory* (things worth
remembering across conversations) and can search the full conversation history of the
project. It writes to core memory after meaningful decisions; you do not have to manage
it.

**Clearing a chat** — "Clear chat" is a real server-side operation: it erases the
stored history, resets the assistant's working state, drops that chat's archival
entries, and resets the context indicator. It is not a UI reset that leaves the model
still remembering everything.

**Editing a message** — nothing is ever destroyed:

- editing your **last** message marks it and everything after it as superseded — the
  answer disappears from view, but the history stays auditable;
- editing an **earlier** message branches the conversation into a new chat and leaves
  the original untouched.

**Interrupting** — you can stop a run at any time. What the assistant had already done
is kept as context, so you can tell it to continue with corrected instructions instead
of starting over.

**Slash commands** — messages starting with `/` are OpalaTex commands rather than
prompts: `/help`, `/clear`, `/skills`, `/models`, `/set-main-model <id>`,
`/set-worker-model <id>`, `/undo`, `/commit <msg>`, and others. Type `/help` for the
full list.
