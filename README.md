# spec-ui

A kanban dashboard for [OpenSpec](https://github.com/Fission-AI/OpenSpec) and [SpecKit](https://github.com/github/spec-kit) changes. Each change lands in a column by its current phase (Proposal → Design → Spec → Tasks → Verify → Archive), so you can see at a glance what's in flight across a project — without running a dozen `openspec status` commands or opening every `tasks.md` by hand.

No install, no dependencies. One Node script, standard library only.

## Why

Spec-driven development leaves its state scattered across markdown files — `openspec/changes/*/`, a `tasks.md` per change, checkboxes buried in headings. Fine for one change; hard to scan once several are in flight, especially across multiple agents or contributors. spec-ui turns that file structure into a board you can glance at, with a live mode that updates itself as files change.

## Features

- **Kanban board**, grouped by source (OpenSpec / SpecKit), columns = phases. A change sits in the column of its first incomplete phase.
- **Dedicated detail view** per change — tabs per artifact (Proposal, Design, Spec, Tasks, Verify), rendered from raw markdown: headings, lists, tables, blockquotes, code fences, task checkboxes, strikethrough, horizontal rules.
- **Tasks sectioned by phase** — `tasks.md` files that use `## Phase N: Title` headings get a collapsible per phase with its own done/total count and progress bar, instead of one long scroll.
- **`--live` mode**: watches `openspec/` and `specs/` with `fs.watch`, auto-refreshes over Server-Sent Events, and fires a native OS notification when a change moves phase (macOS, Windows, Linux).
- **Precise status when available**: shells out to the `openspec` CLI for authoritative artifact status (including `skip_specs`, which file-presence alone can't detect) and to `gh` for real PR status per change, matched by branch name or title. Falls back cleanly to file-based detection when either CLI is missing.
- **Multi-project switcher** (`--live` only): a "Projects" dropdown with recent projects, a native OS folder picker ("Browse…"), and a paste-a-path fallback. Switching re-points the watchers without restarting the process.
- **Search, stale badges, hideable columns** — filter cards by name, see which changes haven't been touched in 14+ days, hide phase columns you don't care about (persisted per browser).
- **Open folder / open terminal** buttons next to the project name, cross-platform.
- **Static mode** (no `--live`): one-shot HTML snapshot, no server, works from a plain `file://` open.

## Install

Nothing to install — it's a single script with zero dependencies. Clone the repo and run it with Node ≥ 18:

```bash
git clone https://github.com/Darell12/spec-ui.git
node spec-ui/bin/dashboard.mjs <path-to-your-project> --live
```

## Usage

```bash
# Live dashboard: auto-refresh, notifications, project switcher
node bin/dashboard.mjs <project> --live

# One-shot static snapshot (writes specs-dashboard.html, no server)
node bin/dashboard.mjs <project>
```

Flags:

| Flag | Effect |
|---|---|
| `--live` | Serve a live-updating dashboard on `http://localhost:4949` instead of writing a static file |
| `--no-open` | Don't auto-open the browser |
| `--no-notify` | Disable native OS notifications in `--live` mode |
| `--test` | Run the built-in self-check |

Optional integrations, detected automatically — no flags needed:

- [`openspec` CLI](https://github.com/Fission-AI/OpenSpec) on `PATH` → precise artifact status per change
- [`gh` CLI](https://cli.github.com/) on `PATH`, authenticated → PR status badges

## Claude Code integration

`.claude/skills/specs-dashboard/SKILL.md` lets an agent open the dashboard when asked ("show me the specs status") instead of you typing the command. Copy that skill folder into any project to enable it there.

## Stack

Node.js standard library only — `fs`, `http`, `child_process`, `assert`. No frontend framework, no bundler, no npm dependencies. The UI is server-rendered HTML/CSS with small vanilla-JS islands for the parts that genuinely need client state (search filter, column visibility, project switching); everything else — including the phase tabs in the detail view — is done with plain CSS (`:target`, radio-button tabs) with no JavaScript at all.

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — free to use, modify, and contribute to for any noncommercial purpose. Commercial use requires a separate license from the copyright holder.
