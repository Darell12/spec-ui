---
name: specs-dashboard
description: Open a visual dashboard of OpenSpec change progress and SpecKit feature progress for the current project. Use when the user asks to see spec/change status, task completion, or which specs are done.
---

Run this from the project root and open the result:

    node <path-to-spec-ui>/bin/dashboard.mjs . --live

It scans `openspec/changes/*/tasks.md` and `specs/*/spec.md` + `tasks.md`,
computes task completion per change/feature, and serves the dashboard on
http://localhost:4949 — opened automatically in the default browser. The
page auto-refreshes (via Server-Sent Events) whenever a watched spec/task
file changes on disk, so it stays live while specs are being worked on.

Leave the process running while the user works; stop it with Ctrl+C.

For a one-off static snapshot instead (writes `specs-dashboard.html`, no
running server), drop `--live`. Pass `--no-open` to skip auto-opening the
browser in either mode.
