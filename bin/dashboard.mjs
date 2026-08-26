#!/usr/bin/env node
// Minimal, dependency-free dashboard for OpenSpec + SpecKit progress.
// Usage: node bin/dashboard.mjs [projectRoot] [--test] [--no-open] [--live]

import { readdirSync, readFileSync, statSync, existsSync, writeFileSync, mkdirSync, watch } from "node:fs";
import { join, basename, resolve, dirname } from "node:path";
import { execSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { homedir } from "node:os";
import assert from "node:assert";

const LIVE_RELOAD_SCRIPT = `<script>new EventSource('/events').onmessage = () => location.reload();</script>`;

// Per-viewer column visibility, persisted in localStorage (falls back to
// in-memory only if storage is unavailable — private mode, some file:// setups).
const COLUMNS_TOGGLE_SCRIPT = `<script>
(function () {
  function storeKey(source) { return "spec-ui:hidden-phases:" + source; }
  function getHidden(source) {
    try { return JSON.parse(localStorage.getItem(storeKey(source)) || "[]"); } catch (e) { return []; }
  }
  function setHidden(source, list) {
    try { localStorage.setItem(storeKey(source), JSON.stringify(list)); } catch (e) {}
  }
  function applyVisibility(source) {
    var hidden = getHidden(source);
    document.querySelectorAll('.column[data-source="' + source + '"]').forEach(function (col) {
      col.style.display = hidden.indexOf(col.dataset.phase) !== -1 ? "none" : "";
    });
    document.querySelectorAll('.cols-menu input[data-source="' + source + '"]').forEach(function (cb) {
      cb.checked = hidden.indexOf(cb.dataset.phase) === -1;
    });
  }
  document.querySelectorAll(".cols-menu input[type=checkbox]").forEach(function (cb) {
    cb.addEventListener("change", function () {
      var source = cb.dataset.source;
      var hidden = getHidden(source);
      var idx = hidden.indexOf(cb.dataset.phase);
      if (cb.checked && idx !== -1) hidden.splice(idx, 1);
      if (!cb.checked && idx === -1) hidden.push(cb.dataset.phase);
      setHidden(source, hidden);
      applyVisibility(source);
    });
  });
  document.addEventListener("click", function (e) {
    document.querySelectorAll(".cols-menu.open").forEach(function (menu) {
      if (!menu.parentElement.contains(e.target)) menu.classList.remove("open");
    });
  });
  var sources = new Set();
  document.querySelectorAll(".column[data-source]").forEach(function (c) { sources.add(c.dataset.source); });
  sources.forEach(applyVisibility);
})();
</script>`;

const SEARCH_SCRIPT = `<script>
(function () {
  var input = document.getElementById("card-search");
  if (!input) return;
  function applyFilter() {
    var q = input.value.trim().toLowerCase();
    document.querySelectorAll(".column").forEach(function (col) {
      var visible = 0;
      col.querySelectorAll(".card").forEach(function (card) {
        var match = !q || card.dataset.name.indexOf(q) !== -1;
        card.style.display = match ? "" : "none";
        if (match) visible++;
      });
      var placeholder = col.querySelector(".col-no-match");
      var hasOriginalCards = col.querySelectorAll(".card").length > 0;
      if (q && hasOriginalCards && visible === 0) {
        if (!placeholder) {
          placeholder = document.createElement("div");
          placeholder.className = "col-empty col-no-match";
          placeholder.textContent = "No matches";
          col.querySelector(".col-body").appendChild(placeholder);
        }
      } else if (placeholder) {
        placeholder.remove();
      }
    });
  }
  input.addEventListener("input", applyFilter);
})();
</script>`;

const PROJECT_SWITCH_SCRIPT = `<script>
(function () {
  function switchProject(path) {
    if (!path) return;
    fetch("/switch-project?path=" + encodeURIComponent(path)).then(function (r) {
      if (r.ok) { location.reload(); return; }
      r.text().then(function (msg) { alert(msg || "Could not switch project"); });
    });
  }
  document.querySelectorAll(".project-item").forEach(function (btn) {
    btn.addEventListener("click", function () { switchProject(btn.dataset.path); });
  });
  document.querySelectorAll(".project-go").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var input = btn.previousElementSibling;
      switchProject(input ? input.value.trim() : "");
    });
  });
})();
</script>`;

const SNIPPET_LIMIT = 6000;

// The openspec CLI's built-in "spec-driven" schema only knows these four
// artifacts — Verify/Archive are this tool's own extension, so they always
// fall back to the file-presence heuristic below regardless of CLI status.
const OPENSPEC_ARTIFACT_TO_PHASE = { proposal: "Proposal", specs: "Spec", design: "Design", tasks: "Tasks" };

let cliAvailable = null;
function hasOpenSpecCli() {
  if (cliAvailable === null) {
    try {
      execSync("openspec --version", { stdio: "ignore", timeout: 3000 });
      cliAvailable = true;
    } catch {
      cliAvailable = false;
    }
  }
  return cliAvailable;
}

// Returns { proposal: "done"|"ready"|"blocked"|"skipped", ... } or null if the
// CLI call fails (not installed, change unknown to it, timeout, bad JSON).
function getCliArtifactStatus(root, changeName) {
  try {
    const out = execSync(`openspec status --change ${JSON.stringify(changeName)} --json`, {
      cwd: root,
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const data = JSON.parse(out.toString("utf8"));
    const byId = {};
    for (const a of data.artifacts || []) byId[a.id] = a.status;
    return byId;
  } catch {
    return null;
  }
}

let ghAvailable = null;
function hasGhCli() {
  if (ghAvailable === null) {
    try {
      execSync("gh --version", { stdio: "ignore", timeout: 3000 });
      ghAvailable = true;
    } catch {
      ghAvailable = false;
    }
  }
  return ghAvailable;
}

// Network call (GitHub, via gh) — unlike the local openspec CLI checks, this
// is worth a short TTL cache so a live-reload burst doesn't refetch per file.
const PR_CACHE_TTL = 30000;
let prCache = { data: null, at: 0 };
function getAllPrs(root) {
  if (!hasGhCli()) return [];
  const now = Date.now();
  if (prCache.data && now - prCache.at < PR_CACHE_TTL) return prCache.data;
  try {
    const out = execSync("gh pr list --state all --json number,state,url,title,headRefName,isDraft --limit 100", {
      cwd: root,
      timeout: 8000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    prCache = { data: JSON.parse(out.toString("utf8")), at: now };
  } catch {
    prCache = { data: [], at: now };
  }
  return prCache.data;
}

// Heuristic match: no stored change<->PR mapping exists, so match by branch
// name first (most reliable if branches are named after the change), then
// fall back to the PR title containing the change name.
function findPrForChange(root, changeName) {
  const prs = getAllPrs(root);
  if (!prs.length) return null;
  const needle = changeName.toLowerCase();
  return (
    prs.find((p) => (p.headRefName || "").toLowerCase().includes(needle)) ||
    prs.find((p) => (p.title || "").toLowerCase().includes(needle)) ||
    null
  );
}

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

        // Non-archived changes: ask the CLI for authoritative status when
        // available — it's the only source that knows about skip_specs etc.
        if (!archived && hasOpenSpecCli()) {
          const cliStatus = getCliArtifactStatus(root, d.name);
          if (cliStatus) {
            for (const phase of phases) {
              const artifactId = Object.keys(OPENSPEC_ARTIFACT_TO_PHASE).find(
                (id) => OPENSPEC_ARTIFACT_TO_PHASE[id] === phase.label
              );
              const status = artifactId && cliStatus[artifactId];
              if (!status) continue;
              phase.skipped = status === "skipped";
              phase.done = status === "done" || status === "skipped";
            }
          }
        }

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
          pr: findPrForChange(root, d.name),
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
        pr: findPrForChange(root, d.name),
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

const STALE_DAYS = 14;

function renderCard(item) {
  const status = statusOf(item);
  const pct = item.tasks && item.tasks.total ? Math.round((item.tasks.done / item.tasks.total) * 100) : 0;
  const taskLabel = item.tasks ? `${item.tasks.done}/${item.tasks.total} tasks` : "no tasks.md";
  const slug = slugify(item.source, item.name);

  const ageDays = item.updated ? Math.floor((Date.now() - item.updated.getTime()) / 86400000) : null;
  const isStale = ageDays !== null && ageDays >= STALE_DAYS;
  const staleBadge = isStale ? `<span class="stale-badge" title="No changes in ${ageDays} days">stale · ${ageDays}d</span>` : "";

  const prBadge = item.pr
    ? `<a class="pr-badge pr-${item.pr.state.toLowerCase()}" href="${item.pr.url}" target="_blank" rel="noopener">PR #${item.pr.number} · ${item.pr.state.toLowerCase()}${item.pr.isDraft ? " (draft)" : ""}</a>`
    : "";

  return `<div class="card status-${status}" data-name="${escapeHtml(item.name.toLowerCase())}">
    <div class="card-top">
      <h3 class="card-name">${item.name}</h3>
      ${staleBadge}
    </div>
    <div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>
    <div class="meta">
      <span>${taskLabel}</span>
      <span>${item.updated ? item.updated.toLocaleDateString() : ""}</span>
    </div>
    ${prBadge}
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
    .map(
      (p) =>
        `<span class="detail-step${p.done ? " done" : ""}${p.skipped ? " skipped" : ""}">${p.label}${p.skipped ? " (skipped)" : ""}</span>`
    )
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
      return `<div class="column" data-source="${source}" data-phase="${escapeHtml(label)}">
        <div class="col-head${isOptional ? " col-optional" : ""}${isLast ? " col-archive" : ""}">
          <span class="col-title">${label}</span>
          <span class="col-count">${byPhase[idx].length}</span>
        </div>
        <div class="col-body">${cards || '<div class="col-empty">Nothing here</div>'}</div>
      </div>`;
    })
    .join("\n");

  const cliNote =
    source === "OpenSpec"
      ? hasOpenSpecCli()
        ? '<span class="cli-badge precise">openspec CLI detected — precise status</span>'
        : '<span class="cli-badge">openspec CLI not found — file-based status</span>'
      : "";

  const columnsMenu = `<div class="columns-toggle">
    <button type="button" class="cols-btn" onclick="this.nextElementSibling.classList.toggle('open')">Columns ▾</button>
    <div class="cols-menu">
      ${phaseLabels
        .map(
          (label) =>
            `<label><input type="checkbox" checked data-source="${source}" data-phase="${escapeHtml(label)}">${label}</label>`
        )
        .join("\n")}
    </div>
  </div>`;

  return `<section class="board-section">
    <div class="board-title-row">
      <h2 class="board-title">${source}</h2>
      ${cliNote}
      ${columnsMenu}
    </div>
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

function renderProjectSwitcher(root, live) {
  if (!live) return "";
  const recents = loadRecentProjects().filter((p) => p !== root);
  const items = recents
    .map(
      (p) =>
        `<button type="button" class="project-item" data-path="${escapeHtml(p)}" title="${escapeHtml(p)}">${escapeHtml(basename(p))}</button>`
    )
    .join("\n");

  return `<div class="columns-toggle project-switch">
    <button type="button" class="cols-btn" onclick="this.nextElementSibling.classList.toggle('open')">Projects ▾</button>
    <div class="cols-menu">
      ${items || '<div class="project-empty">No other recent projects</div>'}
      <div class="project-add">
        <input type="text" class="project-input" placeholder="Paste a project path…">
        <button type="button" class="project-go">Open</button>
      </div>
    </div>
  </div>`;
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
  .page-header { display: flex; align-items: center; gap: 16px; margin-bottom: 4px; }
  .page-header h1 { font-size: 1.35rem; margin: 0; }
  .card-search { font-family: inherit; font-size: 0.8rem; padding: 5px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--text); width: 200px; }
  .card-search:focus { outline: none; border-color: var(--accent); }
  .card-search::placeholder { color: var(--muted); }
  .live-badge { display: inline-flex; align-items: center; gap: 6px; font-size: 0.78rem; color: var(--accent); font-weight: 600; margin-left: auto; }
  .live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); animation: pulse 1.8s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { box-shadow: 0 0 0 0 var(--accent-glow); } 50% { box-shadow: 0 0 0 5px transparent; } }
  .page-sub { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 0.82rem; margin: 0 0 22px; }
  .project-name { color: var(--text); font-weight: 600; text-decoration: none; }
  a.project-name:hover { color: var(--accent); }
  .icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border: 1px solid var(--border); background: var(--surface); color: var(--muted); border-radius: 6px; cursor: pointer; padding: 0; }
  .icon-btn:hover { color: var(--accent); border-color: var(--accent); background: var(--accent-tint); }
  .icon-btn svg { width: 13px; height: 13px; }
  .board-title-row { display: flex; align-items: center; gap: 10px; margin: 0 0 12px; }
  .board-title { font-size: 0.9rem; margin: 0; color: var(--muted); }
  .cli-badge { font-size: 0.68rem; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); }
  .cli-badge.precise { border-color: var(--accent); color: var(--accent); background: var(--accent-tint); }
  .columns-toggle { position: relative; margin-left: auto; }
  .cols-btn { font-size: 0.72rem; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--muted); cursor: pointer; }
  .cols-btn:hover { color: var(--accent); border-color: var(--accent); }
  .cols-menu { display: none; position: absolute; right: 0; top: calc(100% + 6px); background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; z-index: 10; box-shadow: 0 6px 18px rgba(0,0,0,0.25); min-width: 150px; }
  .cols-menu.open { display: block; }
  .cols-menu label { display: flex; align-items: center; gap: 6px; font-size: 0.78rem; padding: 3px 0; cursor: pointer; white-space: nowrap; }
  .project-item { display: block; width: 100%; text-align: left; background: none; border: none; color: var(--text); font-family: inherit; font-size: 0.78rem; padding: 5px 4px; cursor: pointer; border-radius: 4px; white-space: nowrap; }
  .project-item:hover { background: var(--accent-tint); color: var(--accent); }
  .project-empty { font-size: 0.76rem; color: var(--muted); font-style: italic; padding: 4px; white-space: nowrap; }
  .project-add { display: flex; gap: 6px; margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--border); }
  .project-input { flex: 1; min-width: 160px; font-family: inherit; font-size: 0.76rem; padding: 4px 7px; border-radius: 5px; border: 1px solid var(--border); background: var(--bg); color: var(--text); }
  .project-go { font-size: 0.76rem; padding: 4px 9px; border-radius: 5px; border: 1px solid var(--border); background: var(--surface); color: var(--accent); cursor: pointer; }
  .project-go:hover { border-color: var(--accent); background: var(--accent-tint); }
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
  .card-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
  .card-name { font-size: 0.86rem; font-weight: 600; margin: 0; line-height: 1.3; }
  .stale-badge { flex-shrink: 0; font-size: 0.62rem; padding: 2px 7px; border-radius: 999px; border: 1px dashed var(--border); color: var(--muted); white-space: nowrap; }
  .bar { background: rgba(136,136,136,0.22); border-radius: 999px; height: 5px; overflow: hidden; margin-bottom: 6px; }
  .bar-fill { background: var(--accent); height: 100%; }
  .status-no-tasks .bar-fill, .status-not-started .bar-fill { background: var(--muted); }
  .meta { display: flex; align-items: center; justify-content: space-between; font-size: 0.7rem; color: var(--muted); margin-bottom: 8px; }
  .pr-badge { display: inline-block; font-size: 0.68rem; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); text-decoration: none; margin-bottom: 8px; }
  .pr-badge:hover { border-color: var(--accent); color: var(--accent); }
  .pr-badge.pr-merged { border-color: var(--accent); background: var(--accent-tint); color: var(--accent); }
  .detail-link { display: block; font-size: 0.72rem; font-weight: 600; color: var(--accent); text-decoration: none; }
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
  .detail-step.skipped { border-style: dashed; background: transparent; }
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
      <input type="search" id="card-search" class="card-search" placeholder="Filter by name…" autocomplete="off">
      ${live ? '<span class="live-badge"><span class="live-dot"></span>Live</span>' : ""}
    </div>
    <div class="page-sub">${renderProjectLink(root, live)}<span>·</span><span>generated ${new Date().toLocaleString()}</span>${renderProjectSwitcher(root, live)}</div>
    ${boards || '<p class="empty">No openspec/changes or specs/*/spec.md found here.</p>'}
  </div>
  ${detailViews}
  ${COLUMNS_TOGGLE_SCRIPT}
  ${SEARCH_SCRIPT}
  ${live ? PROJECT_SWITCH_SCRIPT : ""}
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

let RECENT_PROJECTS_FILE = join(homedir(), ".spec-ui", "recent-projects.json");
const MAX_RECENT_PROJECTS = 8;

function loadRecentProjects() {
  try {
    const data = JSON.parse(readFileSync(RECENT_PROJECTS_FILE, "utf8"));
    return Array.isArray(data.projects) ? data.projects : [];
  } catch {
    return [];
  }
}

function addRecentProject(root) {
  const list = loadRecentProjects().filter((p) => p !== root);
  list.unshift(root);
  try {
    mkdirSync(dirname(RECENT_PROJECTS_FILE), { recursive: true });
    writeFileSync(RECENT_PROJECTS_FILE, JSON.stringify({ projects: list.slice(0, MAX_RECENT_PROJECTS) }, null, 2));
  } catch {
    // Non-fatal — recent-projects is a convenience, not required for the tool to work.
  }
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

// Best-effort native notification. Silent no-op on failure (e.g. no
// notification daemon on a headless Linux box) — never blocks live-reload.
function notify(title, body) {
  if (process.platform === "darwin") {
    return spawnDetached("osascript", ["-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`]);
  }
  if (process.platform === "win32") {
    const script = `Add-Type -AssemblyName System.Windows.Forms; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; $n.ShowBalloonTip(5000, ${JSON.stringify(title)}, ${JSON.stringify(body)}, [System.Windows.Forms.ToolTipIcon]::Info); Start-Sleep -Seconds 6; $n.Dispose()`;
    return spawnDetached("powershell", ["-NoProfile", "-Command", script]);
  }
  return spawnDetached("notify-send", [title, body]);
}

// ponytail: recursive fs.watch works on macOS/Windows out of the box; Linux needs
// { recursive: true } support (Node 20+) or falls back to non-recursive watch — good
// enough for a single-project PoC, revisit if this ships cross-platform.
function scanPhaseSnapshot(root) {
  const items = [...scanOpenSpec(root), ...scanSpecKit(root)];
  const snapshot = new Map();
  for (const item of items) snapshot.set(`${item.source}:${item.name}`, currentPhaseIndex(item));
  return { items, snapshot };
}

function startLiveServer(root, { port = 4949, open = true, notifyOnChange = true } = {}) {
  const clients = new Set();
  let debounceTimer = null;
  let currentRoot = root;
  let lastSnapshot = notifyOnChange ? scanPhaseSnapshot(currentRoot).snapshot : null;
  let watchers = [];

  function broadcastRefresh() {
    for (const res of clients) res.write("data: refresh\n\n");
  }

  function scheduleRefresh() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (notifyOnChange) {
        const { items, snapshot } = scanPhaseSnapshot(currentRoot);
        for (const item of items) {
          const key = `${item.source}:${item.name}`;
          const prevIdx = lastSnapshot.get(key);
          const newIdx = snapshot.get(key);
          if (prevIdx !== undefined && newIdx !== prevIdx) {
            notify(`${item.name} moved phase`, `${item.phases[prevIdx].label} → ${item.phases[newIdx].label}`);
          }
        }
        lastSnapshot = snapshot;
      }
      broadcastRefresh();
    }, 150);
  }

  function attachWatchers(dirRoot) {
    watchers.forEach((w) => w.close());
    const watchDirs = [join(dirRoot, "openspec"), join(dirRoot, "specs")].filter(existsSync);
    watchers = watchDirs.map((dir) => watch(dir, { recursive: true }, scheduleRefresh));
  }

  function switchTo(newRoot) {
    currentRoot = newRoot;
    lastSnapshot = notifyOnChange ? scanPhaseSnapshot(currentRoot).snapshot : null;
    attachWatchers(currentRoot);
    addRecentProject(currentRoot);
  }

  attachWatchers(currentRoot);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/events") {
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
    if (url.pathname === "/open-folder" || url.pathname === "/open-terminal") {
      const ok = await (url.pathname === "/open-folder" ? openFolder(currentRoot) : openTerminal(currentRoot));
      res.writeHead(ok ? 200 : 500, { "Content-Type": "text/plain" });
      res.end(ok ? "ok" : "failed");
      return;
    }
    if (url.pathname === "/switch-project") {
      const target = resolve(url.searchParams.get("path") || "");
      if (!target || !existsSync(target) || !statSync(target).isDirectory()) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Path does not exist or is not a directory: " + target);
        return;
      }
      switchTo(target);
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }
    const items = [...scanOpenSpec(currentRoot), ...scanSpecKit(currentRoot)];
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(render(currentRoot, items, { live: true }));
  });

  server.on("close", () => watchers.forEach((w) => w.close()));
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use — is another spec-ui --live already running? Try a different project or stop the other instance.`);
      process.exit(1);
    }
    throw err;
  });
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
  // Force the file-based fallback paths regardless of what happens to be
  // installed on the machine running the test — the self-check should be
  // deterministic, not dependent on whether openspec/gh are on this PATH.
  cliAvailable = false;
  ghAvailable = false;

  const os = await import("node:os");
  const fs = await import("node:fs");
  const root = fs.mkdtempSync(join(os.tmpdir(), "spec-ui-test-"));

  // Never touch the real ~/.spec-ui/recent-projects.json during --test.
  RECENT_PROJECTS_FILE = join(root, ".recent-projects-test.json");

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

  assert.ok(html.includes("openspec CLI not found"), "should show the file-based fallback badge when the CLI is forced absent");

  const colCheckboxCount = (html.match(/<input type="checkbox" checked data-source="OpenSpec"/g) || []).length;
  assert.strictEqual(colCheckboxCount, active.phases.length, "columns menu should list one checkbox per phase");
  assert.ok(html.includes('class="column" data-source="OpenSpec" data-phase="Proposal"'), "each column should be taggable by source+phase for the hide/show script");
  assert.ok(html.includes("spec-ui:hidden-phases:"), "columns-toggle script with its localStorage key should be embedded");

  const baseItem = { name: "some-change", tasks: { total: 2, done: 1 }, phases: [], files: [], source: "OpenSpec" };
  const staleCard = renderCard({ ...baseItem, updated: new Date(Date.now() - (STALE_DAYS + 5) * 86400000) });
  const freshCard = renderCard({ ...baseItem, updated: new Date() });
  assert.ok(staleCard.includes("stale-badge"), "a change untouched past the threshold should show the stale badge");
  assert.ok(!freshCard.includes("stale-badge"), "a recently touched change should not show the stale badge");

  const prCard = renderCard({ ...baseItem, updated: new Date(), pr: { number: 5, state: "OPEN", url: "https://example.com/pr/5", isDraft: false } });
  assert.ok(prCard.includes("PR #5") && prCard.includes('href="https://example.com/pr/5"'), "a matched PR should render as a linked badge");
  assert.ok(!freshCard.includes("pr-badge"), "no PR badge should render when the item has none");

  assert.ok(html.includes('id="card-search"'), "the card-name search input should be embedded");

  // findPrForChange matching heuristic, seeded via the cache directly so no
  // real `gh` network call happens during --test.
  ghAvailable = true;
  prCache = {
    data: [
      { number: 10, state: "OPEN", url: "https://x/10", title: "Something else", headRefName: "add-login" },
      { number: 11, state: "MERGED", url: "https://x/11", title: "feat: old-change work", headRefName: "unrelated-branch" },
    ],
    at: Date.now(),
  };
  assert.strictEqual(findPrForChange(root, "add-login").number, 10, "should match by branch name first");
  assert.strictEqual(findPrForChange(root, "old-change").number, 11, "should fall back to matching by PR title");
  assert.strictEqual(findPrForChange(root, "no-such-change"), null, "no match should return null");
  ghAvailable = false;

  // Underlying diff logic for the --live phase-change notification, without
  // actually shelling out to notify() (no real OS popups during --test).
  const beforePhase = scanPhaseSnapshot(root).snapshot.get("OpenSpec:add-login");
  assert.strictEqual(beforePhase, 1, "add-login should start at its first incomplete phase (Design)");
  writeFileSync(join(changeDir, "design.md"), "# design");
  const afterPhase = scanPhaseSnapshot(root).snapshot.get("OpenSpec:add-login");
  assert.strictEqual(afterPhase, 4, "adding design.md should advance add-login to Verify");
  assert.notStrictEqual(beforePhase, afterPhase, "scanPhaseSnapshot should detect the phase change the --live notifier relies on");

  // Recent-projects list: dedup + move-to-front + cap, against the redirected
  // RECENT_PROJECTS_FILE so this never touches the real ~/.spec-ui.
  addRecentProject("/tmp/proj-a");
  addRecentProject("/tmp/proj-b");
  addRecentProject("/tmp/proj-a");
  assert.deepStrictEqual(loadRecentProjects(), ["/tmp/proj-a", "/tmp/proj-b"], "re-adding a project should move it to the front, not duplicate it");
  for (let i = 0; i < MAX_RECENT_PROJECTS + 3; i++) addRecentProject(`/tmp/proj-extra-${i}`);
  assert.strictEqual(loadRecentProjects().length, MAX_RECENT_PROJECTS, "recent-projects list should cap at MAX_RECENT_PROJECTS");

  await testLiveReload(root);
  await testProjectSwitch(root);

  console.log("self-check passed");
}

async function testLiveReload(root) {
  const server = startLiveServer(root, { port: 0, open: false, notifyOnChange: false });
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

async function testProjectSwitch(rootA) {
  const os = await import("node:os");
  const fs = await import("node:fs");
  const rootB = fs.mkdtempSync(join(os.tmpdir(), "spec-ui-test-b-"));
  fs.mkdirSync(join(rootB, "openspec", "changes", "second-project-change"), { recursive: true });
  fs.writeFileSync(join(rootB, "openspec", "changes", "second-project-change", "proposal.md"), "# proposal");

  const server = startLiveServer(rootA, { port: 0, open: false, notifyOnChange: false });
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;

  const before = await (await fetch(`http://localhost:${port}/`)).text();
  assert.ok(before.includes("add-login"), "should initially show rootA's changes");

  const bad = await fetch(`http://localhost:${port}/switch-project?path=` + encodeURIComponent(join(os.tmpdir(), "does-not-exist-xyz")));
  assert.strictEqual(bad.status, 400, "switching to a nonexistent path should be rejected");

  const ok = await fetch(`http://localhost:${port}/switch-project?path=` + encodeURIComponent(rootB));
  assert.strictEqual(ok.status, 200, "switching to a valid project directory should succeed");

  const after = await (await fetch(`http://localhost:${port}/`)).text();
  assert.ok(after.includes("second-project-change"), "after switching, the page should show rootB's changes");
  assert.ok(!after.includes("add-login"), "after switching, rootA's changes should no longer appear");

  assert.ok(loadRecentProjects().includes(rootB), "switching to a project should add it to the recent-projects list");

  server.close();
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--test")) {
    await runSelfCheck();
    return;
  }

  const root = resolve(args.find((a) => !a.startsWith("--")) || process.cwd());
  addRecentProject(root);

  if (args.includes("--live")) {
    startLiveServer(root, { open: !args.includes("--no-open"), notifyOnChange: !args.includes("--no-notify") });
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
