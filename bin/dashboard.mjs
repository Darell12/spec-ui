#!/usr/bin/env node
// Minimal, dependency-free dashboard for OpenSpec + SpecKit progress.
// Usage: node bin/dashboard.mjs [projectRoot] [--test] [--no-open] [--live]

import { readdirSync, readFileSync, statSync, existsSync, writeFileSync, watch } from "node:fs";
import { join, basename, resolve } from "node:path";
import { execSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import assert from "node:assert";

const LIVE_RELOAD_SCRIPT = `<script>new EventSource('/events').onmessage = () => location.reload();</script>`;

const SNIPPET_LIMIT = 6000;

function countTasksInText(text) {
  const total = (text.match(/^[ \t]*-\s*\[[ xX]\]/gm) || []).length;
  const done = (text.match(/^[ \t]*-\s*\[[xX]\]/gm) || []).length;
  return { total, done };
}

function countTasks(tasksMdPath) {
  if (!existsSync(tasksMdPath)) return null;
  return countTasksInText(readFileSync(tasksMdPath, "utf8"));
}

function mtime(path) {
  try {
    return statSync(path).mtime;
  } catch {
    return null;
  }
}

function escapeHtml(str) {
  return str.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function readSnippet(path) {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  if (text.length <= SNIPPET_LIMIT) return text;
  return text.slice(0, SNIPPET_LIMIT) + `\n\n… truncated, open ${path} to read the rest.`;
}

function slugify(...parts) {
  return parts.join("-").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function mdInline(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return out;
}

// ponytail: covers the markdown SDD docs actually use (headings, lists, task
// checkboxes, code fences, bold/italic/code/links) — not full CommonMark.
function mdToHtml(text) {
  const lines = text.split("\n");
  let html = "";
  let inCode = false;
  let listType = null;

  const closeList = () => {
    if (listType) html += `</${listType}>\n`;
    listType = null;
  };
  let paragraph = [];
  const flushParagraph = () => {
    if (paragraph.length) html += `<p>${mdInline(paragraph.join(" "))}</p>\n`;
    paragraph = [];
  };

  let tableBuffer = [];
  const parseRow = (line) =>
    line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  const flushTable = () => {
    if (tableBuffer.length < 2) {
      for (const l of tableBuffer) html += `<p>${mdInline(l.trim())}</p>\n`;
      tableBuffer = [];
      return;
    }
    const isSeparator = /^[\s|:-]+$/.test(tableBuffer[1]) && tableBuffer[1].includes("-");
    if (!isSeparator) {
      for (const l of tableBuffer) html += `<p>${mdInline(l.trim())}</p>\n`;
      tableBuffer = [];
      return;
    }
    const header = parseRow(tableBuffer[0]);
    const bodyRows = tableBuffer.slice(2).map(parseRow);
    html += `<table class="md-table"><thead><tr>${header.map((h) => `<th>${mdInline(h)}</th>`).join("")}</tr></thead><tbody>`;
    for (const row of bodyRows) {
      html += `<tr>${row.map((c) => `<td>${mdInline(c)}</td>`).join("")}</tr>`;
    }
    html += "</tbody></table>\n";
    tableBuffer = [];
  };
  const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      flushParagraph();
      closeList();
      if (tableBuffer.length) flushTable();
      html += inCode ? "</code></pre>\n" : '<pre class="md-code"><code>';
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      html += escapeHtml(line) + "\n";
      continue;
    }

    if (isTableRow(line)) {
      tableBuffer.push(line);
      continue;
    }
    if (tableBuffer.length) {
      flushParagraph();
      closeList();
      flushTable();
    }

    const heading = line.match(/^(#{1,4})\s+(.*)/);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length + 1;
      html += `<h${level} class="md-h${heading[1].length}">${mdInline(heading[2])}</h${level}>\n`;
      continue;
    }

    const checkbox = line.match(/^[ \t]*-\s*\[([ xX])\]\s+(.*)/);
    if (checkbox) {
      flushParagraph();
      if (listType !== "ul") {
        closeList();
        html += '<ul class="md-tasks">\n';
        listType = "ul";
      }
      const done = checkbox[1].toLowerCase() === "x";
      html += `<li class="md-task${done ? " done" : ""}"><input type="checkbox" disabled${done ? " checked" : ""}> <span>${mdInline(checkbox[2])}</span></li>\n`;
      continue;
    }

    const bullet = line.match(/^[ \t]*[-*]\s+(.*)/);
    if (bullet) {
      flushParagraph();
      if (listType !== "ul") {
        closeList();
        html += "<ul>\n";
        listType = "ul";
      }
      html += `<li>${mdInline(bullet[1])}</li>\n`;
      continue;
    }

    const numbered = line.match(/^[ \t]*\d+\.\s+(.*)/);
    if (numbered) {
      flushParagraph();
      if (listType !== "ol") {
        closeList();
        html += "<ol>\n";
        listType = "ol";
      }
      html += `<li>${mdInline(numbered[1])}</li>\n`;
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      closeList();
      continue;
    }

    paragraph.push(line.trim());
  }
  flushParagraph();
  closeList();
  if (tableBuffer.length) flushTable();
  if (inCode) html += "</code></pre>\n";
  return html;
}

// SDD tasks.md consistently groups work under "## Phase N: Title" headings —
// render each as its own collapsible with a per-phase task count, instead of
// one long undifferentiated scroll. Falls back to plain rendering when a
// tasks.md doesn't use phase headings.
function renderTasksPanel(content) {
  const phaseHeading = /^##\s+(Phase\s+\d+.*)$/gm;
  const matches = [...content.matchAll(phaseHeading)];
  if (!matches.length) return mdToHtml(content);

  const intro = content.slice(0, matches[0].index).trim();
  let html = intro ? `<div class="phase-intro">${mdToHtml(intro)}</div>` : "";

  matches.forEach((m, i) => {
    const title = m[1].trim();
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : content.length;
    const body = content.slice(start, end);
    const counts = countTasksInText(body);
    const pct = counts.total ? Math.round((counts.done / counts.total) * 100) : 0;
    html += `<details class="phase-block" open>
      <summary>
        <span class="phase-title">${escapeHtml(title)}</span>
        <span class="phase-count">${counts.total ? `${counts.done}/${counts.total}` : "—"}</span>
      </summary>
      <div class="phase-bar"><div class="phase-bar-fill" style="width:${pct}%"></div></div>
      <div class="phase-body">${mdToHtml(body)}</div>
    </details>`;
  });

  return html;
}

function specDeltaFiles(changeDir) {
  const specsDir = join(changeDir, "specs");
  if (!existsSync(specsDir)) return [];
  return readdirSync(specsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(specsDir, d.name, "spec.md"))
    .filter((p) => existsSync(p));
}

// ponytail: two SDD tools, two folder conventions — kept as two small scanners
// instead of one "generic" abstraction. Add a third scanner if a third tool shows up.
function scanOpenSpec(root) {
  const base = join(root, "openspec", "changes");
  if (!existsSync(base)) return [];

  const collect = (dir, archived) =>
    readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "archive")
      .map((d) => {
        const changeDir = join(dir, d.name);
        const files = {
          proposal: existsSync(join(changeDir, "proposal.md")) ? join(changeDir, "proposal.md") : null,
          design: existsSync(join(changeDir, "design.md")) ? join(changeDir, "design.md") : null,
          tasks: existsSync(join(changeDir, "tasks.md")) ? join(changeDir, "tasks.md") : null,
          verify: existsSync(join(changeDir, "verify-report.md")) ? join(changeDir, "verify-report.md") : null,
        };
        const specDeltas = specDeltaFiles(changeDir);
        const phases = [
          { label: "Proposal", done: !!files.proposal },
          { label: "Design", done: !!files.design, optional: true },
          { label: "Spec", done: specDeltas.length > 0 },
          { label: "Tasks", done: !!files.tasks },
          { label: "Verify", done: !!files.verify },
          { label: "Archive", done: archived },
        ];
        return {
          source: "OpenSpec",
          name: d.name,
          tasks: countTasks(join(changeDir, "tasks.md")),
          phases,
          files: [
            { label: "Proposal", path: files.proposal },
            { label: "Design", path: files.design },
            ...specDeltas.map((p) => ({ label: `Spec: ${basename(join(p, ".."))}`, path: p })),
            { label: "Tasks", path: files.tasks },
            { label: "Verify report", path: files.verify },
          ].filter((f) => f.path),
          updated: mtime(changeDir),
        };
      });

  const archiveDir = join(base, "archive");
  return [
    ...collect(base, false),
    ...(existsSync(archiveDir) ? collect(archiveDir, true) : []),
  ];
}

function scanSpecKit(root) {
  const dir = join(root, "specs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .filter((d) => existsSync(join(dir, d.name, "spec.md")))
    .map((d) => {
      const featureDir = join(dir, d.name);
      const files = {
        spec: join(featureDir, "spec.md"),
        plan: existsSync(join(featureDir, "plan.md")) ? join(featureDir, "plan.md") : null,
        tasks: existsSync(join(featureDir, "tasks.md")) ? join(featureDir, "tasks.md") : null,
      };
      const phases = [
        { label: "Specify", done: true },
        { label: "Plan", done: !!files.plan },
        { label: "Tasks", done: !!files.tasks },
      ];
      return {
        source: "SpecKit",
        name: d.name,
        tasks: countTasks(join(featureDir, "tasks.md")),
        phases,
        files: [
          { label: "Spec", path: files.spec },
          { label: "Plan", path: files.plan },
          { label: "Tasks", path: files.tasks },
        ].filter((f) => f.path),
        updated: mtime(featureDir),
      };
    });
}

function statusOf(item) {
  if (!item.tasks || item.tasks.total === 0) return "no-tasks";
  if (item.tasks.done === item.tasks.total) return "done";
  if (item.tasks.done === 0) return "not-started";
  return "in-progress";
}

const STATUS_LABEL = {
  done: "Done",
  "in-progress": "In progress",
  "not-started": "Not started",
  "no-tasks": "No tasks yet",
};

// A card sits in the column of its first incomplete phase — once every
// phase is done (including Archive) it settles in the last column.
function currentPhaseIndex(item) {
  const idx = item.phases.findIndex((p) => !p.done);
  return idx === -1 ? item.phases.length - 1 : idx;
}

function groupBySource(items) {
  const bySource = new Map();
  for (const item of items) {
    if (!bySource.has(item.source)) bySource.set(item.source, []);
    bySource.get(item.source).push(item);
  }
  return bySource;
}

function renderCard(item) {
  const status = statusOf(item);
  const pct = item.tasks && item.tasks.total ? Math.round((item.tasks.done / item.tasks.total) * 100) : 0;
  const taskLabel = item.tasks ? `${item.tasks.done}/${item.tasks.total} tasks` : "no tasks.md";
  const slug = slugify(item.source, item.name);
  return `<div class="card status-${status}">
    <h3 class="card-name">${item.name}</h3>
    <div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>
    <div class="meta">
      <span>${taskLabel}</span>
      <span>${item.updated ? item.updated.toLocaleDateString() : ""}</span>
    </div>
    <a class="detail-link" href="#detail-${slug}">View details →</a>
  </div>`;
}

// CSS-only tabs: radios + labels + :nth-of-type sibling selectors, no JS.
// Rules are index-based (not slug-based) so one static CSS block, generated
// once in render()'s <style>, covers every item's tab group.
const MAX_TABS = 10;
function tabsCss() {
  let css = "";
  for (let i = 1; i <= MAX_TABS; i++) {
    css += `.tabs input.tab-radio:nth-of-type(${i}):checked ~ .tab-bar .tab-label:nth-of-type(${i}),\n`;
  }
  css = css.slice(0, -2) + " {\n    background: var(--accent-tint); border-color: var(--accent); color: var(--accent);\n  }\n";
  for (let i = 1; i <= MAX_TABS; i++) {
    css += `.tabs input.tab-radio:nth-of-type(${i}):checked ~ .tab-panels .tab-panel:nth-of-type(${i}),\n`;
  }
  css = css.slice(0, -2) + " { display: block; }\n";
  return css;
}

function renderDetailView(item) {
  const slug = slugify(item.source, item.name);
  const steps = item.phases
    .map((p) => `<span class="detail-step${p.done ? " done" : ""}">${p.label}</span>`)
    .join("");

  const tabs = item.files.length
    ? `<div class="tabs">
        ${item.files.map((_, i) => `<input type="radio" class="tab-radio" name="tabs-${slug}" id="tab-${slug}-${i}"${i === 0 ? " checked" : ""}>`).join("\n")}
        <div class="tab-bar">
          ${item.files.map((f, i) => `<label class="tab-label" for="tab-${slug}-${i}">${f.label}</label>`).join("\n")}
        </div>
        <div class="tab-panels">
          ${item.files.map((f) => `<div class="tab-panel">${f.label === "Tasks" ? renderTasksPanel(readSnippet(f.path)) : mdToHtml(readSnippet(f.path))}</div>`).join("\n")}
        </div>
      </div>`
    : '<p class="empty">No readable files for this change yet.</p>';

  return `<div class="detail-view" id="detail-${slug}">
    <a class="detail-back" href="#">← Back to board</a>
    <div class="detail-header">
      <span class="badge-source">${item.source}</span>
      <h1>${item.name}</h1>
      <div class="detail-steps">${steps}</div>
    </div>
    ${tabs}
  </div>`;
}

function renderBoard(source, sourceItems) {
  const phaseLabels = sourceItems[0].phases.map((p) => p.label);
  const byPhase = phaseLabels.map(() => []);
  for (const item of sourceItems) byPhase[currentPhaseIndex(item)].push(item);

  const columns = phaseLabels
    .map((label, idx) => {
      const isOptional = sourceItems[0].phases[idx].optional;
      const isLast = idx === phaseLabels.length - 1;
      const cards = byPhase[idx]
        .sort((a, b) => (b.updated || 0) - (a.updated || 0))
        .map(renderCard)
        .join("\n");
      return `<div class="column">
        <div class="col-head${isOptional ? " col-optional" : ""}${isLast ? " col-archive" : ""}">
          <span class="col-title">${label}</span>
          <span class="col-count">${byPhase[idx].length}</span>
        </div>
        <div class="col-body">${cards || '<div class="col-empty">Nothing here</div>'}</div>
      </div>`;
    })
    .join("\n");

  return `<section class="board-section">
    <h2 class="board-title">${source}</h2>
    <div class="board">${columns}</div>
  </section>`;
}

function renderProjectLink(root, live) {
  const name = escapeHtml(basename(root));
  const tooltip = escapeHtml(root);
  if (!live) {
    return `<a class="project-name" href="file://${encodeURI(root)}" title="${tooltip}">${name}</a>`;
  }
  return `<span class="project-name" title="${tooltip}">${name}</span>
    <button type="button" class="icon-btn" title="Open folder" onclick="fetch('/open-folder').then(r=>{if(!r.ok)alert('Could not open the folder')})">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg>
    </button>
    <button type="button" class="icon-btn" title="Open in terminal" onclick="fetch('/open-terminal').then(r=>{if(!r.ok)alert('No compatible terminal found')})">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z"/><path d="M6.5 9.5 9 12l-2.5 2.5M12 15h5"/></svg>
    </button>`;
}

function render(root, items, { live = false } = {}) {
  const bySource = groupBySource(items);
  const boards = [...bySource.entries()].map(([source, sourceItems]) => renderBoard(source, sourceItems)).join("\n");
  const detailViews = items.map(renderDetailView).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Specs Dashboard — ${basename(root)}</title>
<style>
  :root {
    --bg: #f7f6f3;
    --surface: #ffffff;
    --text: #1a1a1a;
    --muted: #6b6b6f;
    --border: rgba(20,20,22,0.14);
    --accent: #b45309;
    --accent-hover: #92400e;
    --accent-tint: rgba(180,83,9,0.08);
    --accent-tint-strong: rgba(180,83,9,0.12);
    --accent-glow: rgba(180,83,9,0.45);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0c0d10;
      --surface: #16171b;
      --text: #e7e7ea;
      --muted: #8b8d94;
      --border: rgba(255,255,255,0.10);
      --accent: #f2b544;
      --accent-hover: #ffcc66;
      --accent-tint: rgba(242,181,68,0.10);
      --accent-tint-strong: rgba(242,181,68,0.14);
      --accent-glow: rgba(242,181,68,0.5);
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "SF Mono", "Cascadia Code", "Cascadia Mono", Consolas, "JetBrains Mono", "Liberation Mono", Menlo, Monaco, "Courier New", monospace; line-height: 1.5; background: var(--bg); color: var(--text); }
  .page { padding: 28px 32px 40px; }
  .page-header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 4px; }
  .page-header h1 { font-size: 1.35rem; margin: 0; }
  .live-badge { display: inline-flex; align-items: center; gap: 6px; font-size: 0.78rem; color: var(--accent); font-weight: 600; }
  .live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); animation: pulse 1.8s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { box-shadow: 0 0 0 0 var(--accent-glow); } 50% { box-shadow: 0 0 0 5px transparent; } }
  .page-sub { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 0.82rem; margin: 0 0 22px; }
  .project-name { color: var(--text); font-weight: 600; text-decoration: none; }
  a.project-name:hover { color: var(--accent); }
  .icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border: 1px solid var(--border); background: var(--surface); color: var(--muted); border-radius: 6px; cursor: pointer; padding: 0; }
  .icon-btn:hover { color: var(--accent); border-color: var(--accent); background: var(--accent-tint); }
  .icon-btn svg { width: 13px; height: 13px; }
  .board-title { font-size: 0.9rem; margin: 0 0 12px; color: var(--muted); }
  .board-section + .board-section { margin-top: 32px; }
  .board { display: flex; gap: 16px; overflow-x: auto; padding-bottom: 8px; }
  .column { flex: 1 1 220px; min-width: 220px; display: flex; flex-direction: column; gap: 12px; }
  .col-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; border-radius: 8px; background: var(--accent-tint); border: 1px solid transparent; }
  .col-head.col-optional { border-style: dashed; border-color: var(--border); background: transparent; }
  .col-head.col-archive { background: var(--accent-tint-strong); }
  .col-title { font-size: 0.82rem; font-weight: 700; }
  .col-count { font-size: 0.7rem; color: var(--muted); background: var(--surface); border: 1px solid var(--border); border-radius: 999px; padding: 1px 8px; }
  .col-body { display: flex; flex-direction: column; gap: 10px; min-height: 60px; }
  .col-empty { font-size: 0.76rem; color: var(--muted); font-style: italic; padding: 10px 4px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; transition: transform 160ms ease, box-shadow 160ms ease; animation: card-enter 260ms ease; }
  .card:hover { transform: translateY(-2px); box-shadow: 0 6px 18px rgba(0,0,0,0.10); }
  @keyframes card-enter { from { opacity: 0; transform: translateY(-6px) scale(0.97); } to { opacity: 1; transform: none; } }
  .card-name { font-size: 0.86rem; font-weight: 600; margin: 0 0 8px; line-height: 1.3; }
  .bar { background: rgba(136,136,136,0.22); border-radius: 999px; height: 5px; overflow: hidden; margin-bottom: 6px; }
  .bar-fill { background: var(--accent); height: 100%; }
  .status-no-tasks .bar-fill, .status-not-started .bar-fill { background: var(--muted); }
  .meta { display: flex; align-items: center; justify-content: space-between; font-size: 0.7rem; color: var(--muted); margin-bottom: 8px; }
  .detail-link { font-size: 0.72rem; font-weight: 600; color: var(--accent); text-decoration: none; }
  .detail-link:hover { color: var(--accent-hover); }
  .empty { color: var(--muted); font-style: italic; }

  .detail-view { display: none; position: fixed; inset: 0; background: var(--bg); z-index: 50; overflow-y: auto; padding: 32px 24px 60px; }
  .detail-view:target { display: block; }
  .detail-back { display: inline-block; color: var(--muted); text-decoration: none; font-size: 0.82rem; margin-bottom: 18px; }
  .detail-back:hover { color: var(--accent); }
  .detail-header { max-width: 760px; margin: 0 auto; }
  .badge-source { font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
  .detail-header h1 { font-size: 1.4rem; margin: 4px 0 14px; }
  .detail-steps { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
  .detail-step { font-size: 0.72rem; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); }
  .detail-step.done { background: var(--accent-tint); border-color: var(--accent); color: var(--accent); }
  .tabs { max-width: 760px; margin: 28px auto 0; }
  .tab-radio { position: absolute; opacity: 0; width: 0; height: 0; }
  .tab-bar { display: flex; flex-wrap: wrap; gap: 6px; border-bottom: 1px solid var(--border); padding-bottom: 12px; margin-bottom: 24px; }
  .tab-label { font-size: 0.78rem; font-weight: 600; padding: 5px 13px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); cursor: pointer; user-select: none; }
  .tab-label:hover { color: var(--accent); border-color: var(--accent); }
  .tab-panel { display: none; }
  ${tabsCss()}
  .tab-panel h1, .tab-panel h2, .tab-panel h3, .tab-panel h4, .tab-panel h5 { margin: 20px 0 8px; }
  .tab-panel p { line-height: 1.6; margin: 0 0 12px; }
  .tab-panel ul, .tab-panel ol { padding-left: 22px; line-height: 1.6; margin: 0 0 12px; }
  .tab-panel .md-tasks { list-style: none; padding-left: 0; }
  .tab-panel .md-task { display: flex; align-items: baseline; gap: 8px; padding: 2px 0; }
  .tab-panel .md-task.done span { color: var(--muted); text-decoration: line-through; }
  .tab-panel code { background: var(--accent-tint); padding: 1px 5px; border-radius: 4px; font-size: 0.85em; }
  .tab-panel pre.md-code { background: var(--accent-tint); padding: 12px; border-radius: 8px; overflow-x: auto; }
  .tab-panel pre.md-code code { background: none; padding: 0; }
  .tab-panel a { color: var(--accent); }
  .tab-panel table.md-table { width: 100%; border-collapse: collapse; margin: 0 0 16px; font-size: 0.85rem; }
  .tab-panel table.md-table th, .tab-panel table.md-table td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; vertical-align: top; }
  .tab-panel table.md-table th { background: var(--accent-tint); font-weight: 600; }
  .phase-intro { margin-bottom: 24px; }
  .phase-block { border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px; margin-bottom: 12px; }
  .phase-block summary { display: flex; align-items: center; justify-content: space-between; gap: 10px; cursor: pointer; font-weight: 600; }
  .phase-title { font-size: 0.88rem; }
  .phase-count { font-size: 0.72rem; color: var(--muted); background: var(--accent-tint); padding: 2px 9px; border-radius: 999px; flex-shrink: 0; }
  .phase-bar { background: rgba(136,136,136,0.22); border-radius: 999px; height: 4px; overflow: hidden; margin: 10px 0 4px; }
  .phase-bar-fill { background: var(--accent); height: 100%; }
  .phase-body { margin-top: 10px; }
  .phase-body > *:first-child { margin-top: 0; }
</style>
</head>
<body>
  <div class="page">
    <div class="page-header">
      <h1>Specs Dashboard</h1>
      ${live ? '<span class="live-badge"><span class="live-dot"></span>Live</span>' : ""}
    </div>
    <div class="page-sub">${renderProjectLink(root, live)}<span>·</span><span>generated ${new Date().toLocaleString()}</span></div>
    ${boards || '<p class="empty">No openspec/changes or specs/*/spec.md found here.</p>'}
  </div>
  ${detailViews}
  ${live ? LIVE_RELOAD_SCRIPT : ""}
</body>
</html>`;
}

function openInBrowser(target) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    execSync(`${opener} "${target}"`);
  } catch {
    console.log(`Could not auto-open browser, open ${target} manually.`);
  }
}

// Fire-and-forget spawn that resolves true only once the child process has
// actually started — spawn() itself never throws for a missing binary, the
// failure arrives async as an "error" event, so we can't just try/catch it.
function spawnDetached(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: "ignore", detached: true, ...opts });
    } catch {
      resolve(false);
      return;
    }
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

function openFolder(root) {
  if (process.platform === "darwin") return spawnDetached("open", [root]);
  if (process.platform === "win32") return spawnDetached("explorer", [root]);
  return spawnDetached("xdg-open", [root]);
}

// ponytail: Linux has no single standard terminal — try the common ones in
// order and stop at the first that actually launches.
async function openTerminal(root) {
  if (process.platform === "darwin") return spawnDetached("open", ["-a", "Terminal", root]);
  if (process.platform === "win32") return spawnDetached("cmd.exe", ["/c", "start", "cmd.exe"], { cwd: root });

  const candidates = [
    ["gnome-terminal", [`--working-directory=${root}`]],
    ["konsole", ["--workdir", root]],
    ["xfce4-terminal", [`--working-directory=${root}`]],
    ["x-terminal-emulator", [], { cwd: root }],
    ["xterm", [], { cwd: root }],
  ];
  for (const [cmd, args, opts = {}] of candidates) {
    if (await spawnDetached(cmd, args, opts)) return true;
  }
  return false;
}

// ponytail: recursive fs.watch works on macOS/Windows out of the box; Linux needs
// { recursive: true } support (Node 20+) or falls back to non-recursive watch — good
// enough for a single-project PoC, revisit if this ships cross-platform.
function startLiveServer(root, { port = 4949, open = true } = {}) {
  const clients = new Set();
  let debounceTimer = null;

  function broadcastRefresh() {
    for (const res of clients) res.write("data: refresh\n\n");
  }

  function scheduleRefresh() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(broadcastRefresh, 150);
  }

  const watchDirs = [join(root, "openspec"), join(root, "specs")].filter(existsSync);
  const watchers = watchDirs.map((dir) => watch(dir, { recursive: true }, scheduleRefresh));

  const server = createServer(async (req, res) => {
    if (req.url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write("\n");
      clients.add(res);
      const heartbeat = setInterval(() => res.write(":hb\n\n"), 20000);
      req.on("close", () => {
        clearInterval(heartbeat);
        clients.delete(res);
      });
      return;
    }
    if (req.url === "/open-folder" || req.url === "/open-terminal") {
      const ok = await (req.url === "/open-folder" ? openFolder(root) : openTerminal(root));
      res.writeHead(ok ? 200 : 500, { "Content-Type": "text/plain" });
      res.end(ok ? "ok" : "failed");
      return;
    }
    const items = [...scanOpenSpec(root), ...scanSpecKit(root)];
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(render(root, items, { live: true }));
  });

  server.on("close", () => watchers.forEach((w) => w.close()));
  server.listen(port, () => {
    if (open) {
      const { port: actualPort } = server.address();
      console.log(`Live dashboard: http://localhost:${actualPort}`);
      openInBrowser(`http://localhost:${actualPort}`);
    }
  });

  return server;
}

async function runSelfCheck() {
  const os = await import("node:os");
  const fs = await import("node:fs");
  const root = fs.mkdtempSync(join(os.tmpdir(), "spec-ui-test-"));

  const changeDir = join(root, "openspec", "changes", "add-login");
  fs.mkdirSync(join(changeDir, "specs", "auth"), { recursive: true });
  fs.writeFileSync(join(changeDir, "proposal.md"), "# proposal");
  fs.writeFileSync(join(changeDir, "specs", "auth", "spec.md"), "# spec delta");
  fs.writeFileSync(join(changeDir, "tasks.md"), "- [x] 1.1 done\n- [ ] 1.2 pending\n");

  const archivedDir = join(root, "openspec", "changes", "archive", "old-change");
  fs.mkdirSync(archivedDir, { recursive: true });
  fs.writeFileSync(join(archivedDir, "proposal.md"), "# old proposal");
  fs.writeFileSync(join(archivedDir, "tasks.md"), "- [x] 1.1 done\n");
  fs.writeFileSync(join(archivedDir, "verify-report.md"), "# verified");

  fs.mkdirSync(join(root, "specs", "001-search"), { recursive: true });
  fs.writeFileSync(join(root, "specs", "001-search", "spec.md"), "# spec");
  fs.writeFileSync(join(root, "specs", "001-search", "plan.md"), "# plan");
  fs.writeFileSync(join(root, "specs", "001-search", "tasks.md"), "- [x] T001\n- [x] T002\n");

  const openspecItems = scanOpenSpec(root);
  const speckitItems = scanSpecKit(root);

  assert.strictEqual(openspecItems.length, 2, "expected 2 openspec changes (active + archived)");
  const active = openspecItems.find((i) => i.name === "add-login");
  const archived = openspecItems.find((i) => i.name === "old-change");
  assert.ok(active && archived);
  assert.strictEqual(active.tasks.total, 2);
  assert.strictEqual(statusOf(active), "in-progress");
  assert.deepStrictEqual(
    active.phases.map((p) => [p.label, p.done]),
    [
      ["Proposal", true],
      ["Design", false],
      ["Spec", true],
      ["Tasks", true],
      ["Verify", false],
      ["Archive", false],
    ]
  );
  assert.strictEqual(archived.phases.find((p) => p.label === "Archive").done, true);
  assert.strictEqual(archived.phases.find((p) => p.label === "Verify").done, true);

  assert.strictEqual(speckitItems.length, 1, "expected 1 speckit feature");
  assert.strictEqual(speckitItems[0].phases.find((p) => p.label === "Plan").done, true);
  assert.strictEqual(statusOf(speckitItems[0]), "done");

  const html = render(root, [...openspecItems, ...speckitItems]);
  assert.ok(html.includes("add-login"));
  assert.ok(html.includes("001-search"));
  assert.ok(html.includes("spec delta"), "readable content should be embedded");
  assert.ok(html.includes('id="detail-openspec-add-login"'), "detail view should exist per item");
  assert.ok(html.includes('href="#detail-openspec-add-login"'), "card should link to its detail view");

  const md = mdToHtml("# Title\n\n- [x] done task\n- [ ] pending task\n\nSome **bold** and `code` and <script>alert(1)</script>.\n");
  assert.ok(md.includes("<h2 class=\"md-h1\">Title</h2>"), "heading should render");
  assert.ok(md.includes('<li class="md-task done">'), "checked task should get the done class");
  assert.ok(md.includes('<input type="checkbox" disabled>'), "unchecked task should render an unchecked checkbox");
  assert.ok(md.includes("<strong>bold</strong>") && md.includes("<code>code</code>"), "inline markdown should render");
  assert.ok(!md.includes("<script>alert"), "raw HTML in markdown source must be escaped");

  const table = mdToHtml("| Area | Impact |\n|------|--------|\n| a.ts | New |\n");
  assert.ok(table.includes("<table") && table.includes("<th>Area</th>") && table.includes("<td>New</td>"), "markdown tables should render as tables, not raw pipes");

  const tasksMd = [
    "# Tasks: Sample",
    "## Review Workload Forecast",
    "Some forecast text.",
    "## Phase 0: Setup",
    "- [x] 0.1 done",
    "- [ ] 0.2 pending",
    "## Phase 1: Build",
    "- [x] 1.1 done",
    "- [x] 1.2 done",
    "",
  ].join("\n");
  const phased = renderTasksPanel(tasksMd);
  assert.ok(phased.includes('class="phase-intro"'), "content before the first Phase heading should be its own intro block");
  assert.ok(phased.includes("Phase 0: Setup") && phased.includes("Phase 1: Build"), "each Phase heading should get its own section");
  assert.ok(phased.match(/<span class="phase-count">1\/2<\/span>/), "phase 0 should count 1 of 2 tasks done");
  assert.ok(phased.match(/<span class="phase-count">2\/2<\/span>/), "phase 1 should count 2 of 2 tasks done");
  assert.strictEqual(renderTasksPanel("- [x] no phases here\n"), mdToHtml("- [x] no phases here\n"), "no Phase headings should fall back to plain rendering");

  await testLiveReload(root);

  console.log("self-check passed");
}

async function testLiveReload(root) {
  const server = startLiveServer(root, { port: 0, open: false });
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;

  const pageRes = await fetch(`http://localhost:${port}/`);
  assert.strictEqual(pageRes.status, 200);
  assert.ok((await pageRes.text()).includes("EventSource"), "live page should include the reload script");

  const controller = new AbortController();
  const sseRes = await fetch(`http://localhost:${port}/events`, { signal: controller.signal });
  const abortTimer = setTimeout(() => controller.abort(), 3000);

  setTimeout(() => {
    writeFileSync(join(root, "openspec", "changes", "add-login", "tasks.md"), "- [x] 1.1 done\n- [x] 1.2 done\n");
  }, 100);

  const decoder = new TextDecoder();
  let received = "";
  try {
    for await (const chunk of sseRes.body) {
      received += decoder.decode(chunk);
      if (received.includes("refresh")) break;
    }
  } catch (err) {
    if (err.name !== "AbortError") throw err;
  } finally {
    clearTimeout(abortTimer);
  }

  server.close();
  assert.ok(received.includes("refresh"), "expected an SSE refresh event after a watched file changed");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--test")) {
    await runSelfCheck();
    return;
  }

  const root = resolve(args.find((a) => !a.startsWith("--")) || process.cwd());

  if (args.includes("--live")) {
    startLiveServer(root, { open: !args.includes("--no-open") });
    return; // server.listen keeps the process alive
  }

  const items = [...scanOpenSpec(root), ...scanSpecKit(root)];
  const html = render(root, items);
  const outPath = join(root, "specs-dashboard.html");
  writeFileSync(outPath, html);
  console.log(`Wrote ${outPath} (${items.length} spec/change(s) found)`);

  if (!args.includes("--no-open")) openInBrowser(outPath);
}

main();
