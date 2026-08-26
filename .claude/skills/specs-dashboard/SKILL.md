---
name: specs-dashboard
description: Open a visual dashboard of OpenSpec change progress and SpecKit feature progress for the current project. Use when the user asks to see spec/change status, task completion, or which specs are done.
---

Run this from the project root and open the result:

    node <path-to-spec-ui>/bin/dashboard.mjs .

It scans `openspec/changes/*/tasks.md` and `specs/*/spec.md` + `tasks.md`,
computes task completion per change/feature, writes `specs-dashboard.html`
in the project root, and opens it in the default browser automatically.

No flags needed for normal use. Pass `--no-open` to only write the file.
