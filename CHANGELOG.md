# Changelog

All notable changes to dsh-autoresume are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-17

### Added

- Initial release.
- Auto-continue an interrupted dsh session after a web restart:
  - Reads the target session's persisted event stream via `ctx.sessionPersistence.inspect()`.
  - Detects an interrupted turn (open turn/step, unresolved `tool/call`, or `turn/end` reason = `interrupted`).
  - Injects one "继续（自动）" user message via `ctx.agents.get(target)` → `agent.followup()`.
  - One-shot per process; completed/settled sessions are left untouched (no duplicate-injection loops).
- Config-driven: `targetSessionId`, `bootGraceMs`, `initialDelayMs`, `pollIntervalMs`, `promptText`.
- Verified against repeated `systemctl restart dsh-web` (each process injects exactly once).
