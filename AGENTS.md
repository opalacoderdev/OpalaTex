# General Rules

0. **MANDATORY**: At the start of a new chat/session in this project, read the project design documentation in [PROJECT_DESIGN.md](./PROJECT_DESIGN.md) before doing project work so you understand the software architecture, design decisions, and client-server connectivity. Within the same chat/session, do not re-read it before every user request unless the design may have changed, the task touches architecture or project design, or you need to refresh context.

0.1. When making substantial architectural or project-design changes, update [PROJECT_DESIGN.md](./PROJECT_DESIGN.md) in the same change so the design documentation stays accurate.

1. Don't make baseless assumptions; before drawing any conclusions, conduct tests and analysis to gather as much information as possible.

1.1. Do not implement kludges, ad hoc semantic fallbacks, or hidden behavior substitutions without explicit user authorization. In particular, do not "fix" an invalid tool call by silently converting it into a different action. Preserve tool contracts, fail fast with a clear diagnostic, add bounded loop breakers when needed, and ask the user before introducing compatibility hacks.

# Project Guide

## Language

All code, comments, and documentation must be written in **English**.
Hardcoded text in UI components, default values, error messages, and string literals must be written in **English**. User-facing strings that need localization should use the i18n framework (`useTranslation` / `t()`) with English as the default value.

## Architecture

This project uses the **AgenticBlocks.IO** framework.
Before starting any task, read the library source and documentation at:
https://github.com/gilzamir/agenticblocks

Key things to understand from that repo:
- How blocks are structured and composed
- How agents communicate and dispatch events
- Naming conventions used throughout the framework

## Build & Test Commands
Run tests on tests dir after you implement a new feature.


> Fill in your actual commands below — this is the highest-value section.

```bash
python -m pytest
```
