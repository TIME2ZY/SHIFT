# Sanitized legacy runtime fixture

This directory is the only checked-in representation of the pre-cutover runtime formats.
It is synthetic, minimal, and contains no user history, credentials, machine-specific user
paths, or provider secrets.

Covered formats:

- `sessions.json`: legacy thread and message authority;
- `invocations.json`: legacy invocation registry;
- `transcripts/<thread>/invocations/*.jsonl`: legacy event transcript;
- `session-maps/<thread>/sessions.json`: legacy provider resume mapping.

Tests must copy this directory to a temporary directory before exercising mutable legacy
code. Product runtime must never read this fixture.
