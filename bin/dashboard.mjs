#!/usr/bin/env node
// Minimal, dependency-free dashboard for OpenSpec + SpecKit progress.
// Usage: node bin/dashboard.mjs [projectRoot] [--test] [--no-open] [--live]

import { readdirSync, readFileSync, statSync, existsSync, writeFileSync, watch } from "node:fs";
import { join, basename } from "node:path";
import { execSync } from "node:child_process";
import { createServer } from "node:http";
import assert from "node:assert";

const LIVE_RELOAD_SCRIPT = `<script>new EventSource('/events').onmessage = () => location.reload();</script>`;

const SNIPPET_LIMIT = 6000;

function countTasks(tasksMdPath) {
  if (!existsSync(tasksMdPath)) return null;
  const text = readFileSync(tasksMdPath, "utf8");
  const total = (text.match(/^[ \t]*-\s*\[[ xX]\]/gm) || []).length;
  const done = (text.match(/^[ \t]*-\s*\[[xX]\]/gm) || []).length;
  return { total, done };
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

function renderFiles(files) {
  if (!files.length) return "";
  return files
    .map((f) => {
      const content = readSnippet(f.path);
      return `<details>
        <summary>${f.label}</summary>
        <pre>${escapeHtml(content)}</pre>
      </details>`;
    })
    .join("\n");
}

function renderCard(item) {
  const status = statusOf(item);
  const pct = item.tasks && item.tasks.total ? Math.round((item.tasks.done / item.tasks.total) * 100) : 0;
  const taskLabel = item.tasks ? `${item.tasks.done}/${item.tasks.total} tasks` : "no tasks.md";
  return `<div class="card status-${status}">
    <h3 class="card-name">${item.name}</h3>
    <div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>
    <div class="meta">
      <span>${taskLabel}</span>
      <span>${item.updated ? item.updated.toLocaleDateString() : ""}</span>
    </div>
    <div class="files">${renderFiles(item.files)}</div>
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
        <div class="col-body">${cards || '<div class="col-empty">Nada acá</div>'}</div>
      </div>`;
    })
    .join("\n");

  return `<section class="board-section">
    <h2 class="board-title">${source}</h2>
    <div class="board">${columns}</div>
  </section>`;
}

function render(root, items, { live = false } = {}) {
  const bySource = groupBySource(items);
  const boards = [...bySource.entries()].map(([source, sourceItems]) => renderBoard(source, sourceItems)).join("\n");

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
  body { margin: 0; font-family: -apple-system, system-ui, sans-serif; background: var(--bg); color: var(--text); }
  .page { padding: 28px 32px 40px; }
  .page-header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 4px; }
  .page-header h1 { font-size: 1.35rem; margin: 0; }
  .live-badge { display: inline-flex; align-items: center; gap: 6px; font-size: 0.78rem; color: var(--accent); font-weight: 600; }
  .live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); animation: pulse 1.8s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { box-shadow: 0 0 0 0 var(--accent-glow); } 50% { box-shadow: 0 0 0 5px transparent; } }
  .page-sub { color: var(--muted); font-size: 0.82rem; margin: 0 0 22px; }
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
  .meta { display: flex; align-items: center; justify-content: space-between; font-size: 0.7rem; color: var(--muted); }
  .files { margin-top: 8px; }
  .files details { border-top: 1px solid var(--border); padding: 6px 0; }
  .files summary { cursor: pointer; font-size: 0.74rem; font-weight: 600; }
  .files pre { white-space: pre-wrap; font-size: 0.72rem; max-height: 260px; overflow-y: auto; background: var(--accent-tint); padding: 8px; border-radius: 6px; }
  .empty { color: var(--muted); font-style: italic; }
</style>
</head>
<body>
  <div class="page">
    <div class="page-header">
      <h1>Specs Dashboard</h1>
      ${live ? '<span class="live-badge"><span class="live-dot"></span>Live</span>' : ""}
    </div>
    <div class="page-sub">${root} — generated ${new Date().toLocaleString()}</div>
    ${boards || '<p class="empty">No openspec/changes or specs/*/spec.md found here.</p>'}
  </div>
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

  const server = createServer((req, res) => {
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

  const root = args.find((a) => !a.startsWith("--")) || process.cwd();

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
