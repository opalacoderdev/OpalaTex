# General Rules

1. Don't make baseless assumptions; before drawing any conclusions, conduct tests and analysis to gather as much information as possible.

# Project Guide

## Language

All code, comments, and documentation must be written in **English**.

## Architecture

This project uses the **AgenticBlocks.IO** framework.
Before starting any task, read the library source and documentation at:
https://github.com/gilzamir/agenticblocks

Key things to understand from that repo:
- How blocks are structured and composed
- How agents communicate and dispatch events
- Naming conventions used throughout the framework

## Project Context

Read `ARCH_SUMMARY.md` before making changes. It contains the current project status,
known issues, and decisions already made. Do not re-litigate what is documented there.

## Build & Test Commands
Run tests on tests dir after you implement a new feature.


> Fill in your actual commands below — this is the highest-value section.

```bash
python -m pytest
```