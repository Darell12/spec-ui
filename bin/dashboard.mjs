#!/usr/bin/env node
// Minimal, dependency-free dashboard for OpenSpec + SpecKit progress.
// Usage: node bin/dashboard.mjs [projectRoot] [--test] [--no-open]

import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { execSync } from "node:child_process";
import assert from "node:assert";

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

function renderPhaseChips(phases) {
  return phases
    .map(
      (p) =>
        `<span class="chip ${p.done ? "chip-done" : "chip-pending"}${p.optional ? " chip-optional" : ""}">${p.label}</span>`
    )
    .join("");
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

function render(root, items) {
  const rows = items
    .sort((a, b) => (b.updated || 0) - (a.updated || 0))
    .map((item) => {
      const status = statusOf(item);
      const pct = item.tasks && item.tasks.total ? Math.round((item.tasks.done / item.tasks.total) * 100) : 0;
      const taskLabel = item.tasks ? `${item.tasks.done}/${item.tasks.total} tasks` : "no tasks.md";
      return `<div class="card status-${status}">
        <div class="card-head">
          <span class="badge badge-${item.source.toLowerCase()}">${item.source}</span>
          <h3>${item.name}</h3>
        </div>
        <div class="chips">${renderPhaseChips(item.phases)}</div>
        <div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>
        <div class="meta">
          <span>${taskLabel}</span>
          <span class="status-label">${STATUS_LABEL[status]}</span>
        </div>
        <div class="files">${renderFiles(item.files)}</div>
      </div>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Specs Dashboard — ${basename(root)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 900px; margin: 40px auto; padding: 0 20px; }
  h1 { font-size: 1.3rem; }
  .sub { color: #888; font-size: 0.85rem; margin-bottom: 24px; }
  .grid { display: grid; gap: 14px; }
  .card { border: 1px solid #8883; border-radius: 10px; padding: 14px 16px; }
  .card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .card-head h3 { margin: 0; font-size: 1rem; }
  .badge { font-size: 0.7rem; padding: 2px 8px; border-radius: 999px; font-weight: 600; }
  .badge-openspec { background: #6366f133; color: #6366f1; }
  .badge-speckit { background: #f59e0b33; color: #b45309; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
  .chip { font-size: 0.68rem; padding: 2px 8px; border-radius: 6px; border: 1px solid #8884; }
  .chip-done { background: #22c55e22; border-color: #22c55e55; }
  .chip-pending { color: #999; }
  .chip-optional { border-style: dashed; }
  .bar { background: #8882; border-radius: 999px; height: 6px; overflow: hidden; margin-bottom: 8px; }
  .bar-fill { background: #22c55e; height: 100%; }
  .status-no-tasks .bar-fill { background: #9ca3af; }
  .status-not-started .bar-fill { background: #9ca3af; }
  .status-in-progress .bar-fill { background: #f59e0b; }
  .meta { display: flex; justify-content: space-between; font-size: 0.8rem; color: #888; }
  .empty { color: #888; font-style: italic; }
  .files { margin-top: 10px; }
  .files details { border-top: 1px solid #8882; padding: 6px 0; }
  .files summary { cursor: pointer; font-size: 0.8rem; font-weight: 600; }
  .files pre { white-space: pre-wrap; font-size: 0.78rem; max-height: 300px; overflow-y: auto; background: #8881; padding: 8px; border-radius: 6px; }
</style>
</head>
<body>
  <h1>Specs Dashboard</h1>
  <div class="sub">${root} — generated ${new Date().toLocaleString()}</div>
  <div class="grid">
    ${rows || '<p class="empty">No openspec/changes or specs/*/spec.md found here.</p>'}
  </div>
</body>
</html>`;
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

  console.log("self-check passed");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--test")) {
    await runSelfCheck();
    return;
  }

  const root = args.find((a) => !a.startsWith("--")) || process.cwd();
  const items = [...scanOpenSpec(root), ...scanSpecKit(root)];
  const html = render(root, items);
  const outPath = join(root, "specs-dashboard.html");
  writeFileSync(outPath, html);
  console.log(`Wrote ${outPath} (${items.length} spec/change(s) found)`);

  if (!args.includes("--no-open")) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    try {
      execSync(`${opener} "${outPath}"`);
    } catch {
      console.log("Could not auto-open browser, open the file manually.");
    }
  }
}

main();
