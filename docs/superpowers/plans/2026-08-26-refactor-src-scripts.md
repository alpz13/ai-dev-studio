# Refactor: Scripts, index.html, Director Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize scripts into `__tests__/`, split `index.html` into HTML/CSS/JS, and refactor `director.ts` into a thin loop backed by stage modules and extracted mechanics.

**Architecture:** Three independent refactors applied in order: (1) file moves + package.json path updates, (2) CSS/JS extraction with no server changes, (3) director split into `pipeline.ts` (types + registry), `stages/*.ts` (per-stage logic), `pipeline-mechanics.ts` (retry/resume/error), and a rewritten thin `director.ts` loop.

**Tech Stack:** TypeScript, ESM (`"type": "module"`, `.js` extensions in imports), tsx (no build step), `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`

**Spec:** `docs/superpowers/specs/2026-08-26-refactor-src-scripts-design.md`

## Global Constraints

- All imports use `.js` extensions even for `.ts` source files (NodeNext module resolution)
- No new runtime dependencies — only files already in the project
- `npm run typecheck` must pass with zero errors after every task
- Pure refactor — no behavior changes; all existing logic moves verbatim

---

## File Map

| Action | Path |
|---|---|
| Move | `scripts/test-*.ts` → `scripts/__tests__/test-*.ts` (6 files) |
| Modify | `package.json` — update 6 `test:*` paths |
| Modify | `src/web/public/index.html` — replace `<style>` and `<script>` blocks |
| Create | `src/web/public/style.css` — extracted CSS |
| Create | `src/web/public/app.js` — extracted JS |
| Create | `src/agents/director/pipeline.ts` — types + PIPELINE array |
| Create | `src/agents/director/stages/pm.ts` |
| Create | `src/agents/director/stages/architect.ts` |
| Create | `src/agents/director/stages/dev.ts` |
| Create | `src/agents/director/stages/qa.ts` |
| Create | `src/agents/director/stages/devops.ts` |
| Create | `src/agents/director/pipeline-mechanics.ts` |
| Rewrite | `src/agents/director/director.ts` — thin loop (~65 lines) |

---

## Task 1: Scripts `__tests__` Folder

**Files:**
- Move: `scripts/test-*.ts` → `scripts/__tests__/` (6 files)
- Modify: `package.json:8-18`

**Interfaces:**
- Produces: nothing consumed by later tasks — standalone

- [ ] **Step 1: Create the folder and move the six test files**

```bash
mkdir scripts/__tests__
mv scripts/test-core.ts scripts/__tests__/test-core.ts
mv scripts/test-agent-loop-helpers.ts scripts/__tests__/test-agent-loop-helpers.ts
mv scripts/test-feature-state-client.ts scripts/__tests__/test-feature-state-client.ts
mv scripts/test-feature-state-store.ts scripts/__tests__/test-feature-state-store.ts
mv scripts/test-filesystem-git-ops.ts scripts/__tests__/test-filesystem-git-ops.ts
mv scripts/test-trace-logger.ts scripts/__tests__/test-trace-logger.ts
```

- [ ] **Step 2: Update `package.json` `test:*` paths**

In `package.json`, change all six `test:*` script values:

```json
"test:store":        "tsx scripts/__tests__/test-feature-state-store.ts",
"test:mcp-client":   "tsx scripts/__tests__/test-feature-state-client.ts",
"test:core":         "tsx scripts/__tests__/test-core.ts",
"test:fs-git":       "tsx scripts/__tests__/test-filesystem-git-ops.ts",
"test:trace-logger": "tsx scripts/__tests__/test-trace-logger.ts",
"test:agent-helpers":"tsx scripts/__tests__/test-agent-loop-helpers.ts",
```

- [ ] **Step 3: Verify typecheck passes**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add scripts/__tests__/ package.json
git commit -m "refactor: move test scripts into scripts/__tests__/"
```

---

## Task 2: Split `index.html` into HTML + CSS + JS

**Files:**
- Modify: `src/web/public/index.html`
- Create: `src/web/public/style.css`
- Create: `src/web/public/app.js`

**Interfaces:**
- Produces: nothing consumed by later tasks — standalone

- [ ] **Step 1: Create `src/web/public/style.css`**

Extract the entire content of the `<style>` block (lines 8–133 of `index.html`, without the `<style>` tags themselves):

```css
  :root {
    --bg: #0f1115;
    --panel: #171a21;
    --border: #2a2e38;
    --text: #e6e8ec;
    --muted: #8a8f9c;
    --accent: #5b8cff;
    --pending: #3a3f4b;
    --in_progress: #5b8cff;
    --done: #3ecf8e;
    --failed: #ef5b5b;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
  }
  main {
    max-width: 780px;
    margin: 0 auto;
    padding: 2rem 1.25rem 4rem;
  }
  h1 { font-size: 1.4rem; margin: 0 0 0.25rem; }
  .subtitle { color: var(--muted); margin: 0 0 1.5rem; font-size: 0.9rem; }
  .panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1rem 1.25rem;
    margin-bottom: 1.25rem;
  }
  .panel h2 { font-size: 0.95rem; margin: 0 0 0.75rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  form { display: flex; gap: 0.5rem; }
  input[type="text"] {
    flex: 1;
    background: #0d0f14;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    padding: 0.55rem 0.7rem;
    font-size: 0.92rem;
  }
  input[type="text"]:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  button {
    background: var(--accent);
    color: white;
    border: none;
    border-radius: 6px;
    padding: 0.55rem 1rem;
    font-size: 0.9rem;
    cursor: pointer;
  }
  button:hover { filter: brightness(1.08); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.secondary { background: #2a2e38; }
  ul.pending-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
  ul.pending-list li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0.6rem;
    background: #0d0f14;
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 0.85rem;
  }
  ul.pending-list .title { color: var(--text); }
  ul.pending-list .meta { color: var(--muted); font-size: 0.78rem; }
  .empty { color: var(--muted); font-size: 0.85rem; font-style: italic; }

  .session-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 0.9rem; }
  .session-header code { color: var(--accent); }

  .stages { display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
  .stage-badge {
    flex: 1;
    min-width: 90px;
    text-align: center;
    padding: 0.5rem 0.4rem;
    border-radius: 6px;
    border: 1px solid var(--border);
    font-size: 0.8rem;
    background: #0d0f14;
    color: var(--muted);
    transition: background 0.2s, color 0.2s, border-color 0.2s;
  }
  .stage-badge .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 0.35rem; background: var(--pending); }
  .stage-badge[data-status="in_progress"] { border-color: var(--in_progress); color: var(--text); }
  .stage-badge[data-status="in_progress"] .dot { background: var(--in_progress); animation: pulse 1.1s infinite ease-in-out; }
  .stage-badge[data-status="done"] { border-color: var(--done); color: var(--text); }
  .stage-badge[data-status="done"] .dot { background: var(--done); }
  .stage-badge[data-status="failed"] { border-color: var(--failed); color: var(--text); }
  .stage-badge[data-status="failed"] .dot { background: var(--failed); }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

  .log {
    background: #0a0c10;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.75rem 0.9rem;
    height: 340px;
    overflow-y: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.78rem;
    line-height: 1.5;
  }
  .log .line { white-space: pre-wrap; word-break: break-word; }
  .log .line .ts { color: var(--muted); }
  .log .line .role { color: var(--accent); }
  .log .line.error .role { color: var(--failed); }
  .log .line .evt { color: var(--muted); }

  .summary { margin-top: 1rem; border-top: 1px solid var(--border); padding-top: 0.9rem; }
  .summary h3 { font-size: 0.85rem; margin: 0 0 0.6rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .summary-totals { display: flex; gap: 1.25rem; flex-wrap: wrap; margin-bottom: 0.75rem; font-size: 0.85rem; }
  .summary-totals .metric .value { font-size: 1.05rem; color: var(--text); }
  .summary-totals .metric .label { color: var(--muted); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.03em; }
  table.summary-stages { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
  table.summary-stages th, table.summary-stages td { text-align: left; padding: 0.35rem 0.5rem; border-bottom: 1px solid var(--border); }
  table.summary-stages th { color: var(--muted); font-weight: 500; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.03em; }
  .resume-note { margin-top: 0.75rem; font-size: 0.8rem; color: var(--muted); }
  .resume-note.interrupted { color: var(--in_progress); }
  .resume-note.blocked { color: var(--failed); }
```

- [ ] **Step 2: Create `src/web/public/app.js`**

Extract the entire content of the `<script>` block (lines 172–392 of `index.html`, without the `<script>` tags):

```js
(function () {
  var STAGES = ["PM", "Architect", "Dev", "QA", "DevOps"];

  var startPanel = document.getElementById("start-panel");
  var resumePanel = document.getElementById("resume-panel");
  var sessionPanel = document.getElementById("session-panel");
  var pendingListEl = document.getElementById("pending-list");
  var stageBadgesEl = document.getElementById("stage-badges");
  var logEl = document.getElementById("log");
  var sessionFeatureIdEl = document.getElementById("session-feature-id");
  var summaryPanelEl = document.getElementById("summary-panel");
  var summaryContentEl = document.getElementById("summary-content");
  var startForm = document.getElementById("start-form");
  var taskInput = document.getElementById("task-input");
  var backButton = document.getElementById("back-button");

  var currentSource = null;
  var stageStatus = {};

  function resetStages() {
    stageStatus = {};
    STAGES.forEach(function (s) { stageStatus[s] = "pending"; });
    renderStages();
  }

  function renderStages() {
    stageBadgesEl.innerHTML = "";
    STAGES.forEach(function (stage) {
      var el = document.createElement("div");
      el.className = "stage-badge";
      el.dataset.status = stageStatus[stage];
      el.innerHTML = '<span class="dot"></span>' + stage;
      stageBadgesEl.appendChild(el);
    });
  }

  function appendLog(event) {
    var line = document.createElement("div");
    line.className = "line" + (event.event === "error" ? " error" : "");
    var ts = event.timestamp ? event.timestamp.split("T")[1].replace("Z", "") : "";
    var detail = "";
    if (event.event === "message" && event.note) detail = event.note;
    else if (event.event === "tool_call" && event.tool) detail = "tool: " + event.tool;
    else if (event.event === "tool_result" && event.tool) detail = "tool result: " + event.tool + (event.isError ? " (error)" : "");
    else if (event.event === "agent_end" && event.output) detail = String(event.output).slice(0, 160);
    else if (event.event === "error" && event.output) detail = String(event.output).slice(0, 200);
    var nesting = event.parentSpanId ? " ↳ " : "";
    line.innerHTML =
      '<span class="ts">[' + ts + ']</span> ' +
      nesting +
      '<span class="role">' + event.agentRole + '</span> ' +
      '<span class="evt">' + event.event + '</span>' +
      (detail ? " &mdash; " + escapeHtml(detail) : "");
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; });
  }

  function applyEventToStages(event) {
    if (event.parentSpanId) return;

    if (STAGES.indexOf(event.agentRole) !== -1) {
      if (event.event === "agent_start") stageStatus[event.agentRole] = "in_progress";
      else if (event.event === "agent_end") stageStatus[event.agentRole] = "done";
      else if (event.event === "error") stageStatus[event.agentRole] = "failed";
      renderStages();
      return;
    }

    if (event.agentRole === "Director" && event.event === "message" && event.stage === "QA" && /retry/i.test(String(event.note))) {
      stageStatus.QA = "failed";
      stageStatus.Dev = "in_progress";
      renderStages();
    }
  }

  function formatMs(ms) {
    if (ms === null || ms === undefined) return "n/a";
    if (ms < 1000) return ms + "ms";
    return (ms / 1000).toFixed(1) + "s";
  }

  function renderSummary(summary) {
    var totalsHtml =
      '<div class="summary-totals">' +
      '<div class="metric"><div class="value">' + summary.outcome + '</div><div class="label">outcome</div></div>' +
      '<div class="metric"><div class="value">' + formatMs(summary.totalDurationMs) + '</div><div class="label">total duration</div></div>' +
      '<div class="metric"><div class="value">' + summary.totalTokensUsed + '</div><div class="label">tokens used</div></div>' +
      '<div class="metric"><div class="value">' + summary.qaRetries + '</div><div class="label">QA retries</div></div>' +
      '</div>';

    var rows = summary.stages.map(function (s) {
      return (
        "<tr><td>" + s.stage + "</td><td>" + s.runs + "</td><td>" + formatMs(s.durationMs) + "</td><td>" + s.tokensUsed + "</td>" +
        "<td>" + (s.incomplete ? "incomplete" : "") + "</td></tr>"
      );
    }).join("");
    var tableHtml =
      '<table class="summary-stages"><thead><tr><th>Stage</th><th>Runs</th><th>Duration</th><th>Tokens</th><th></th></tr></thead>' +
      "<tbody>" + rows + "</tbody></table>";

    var resumeHtml = (summary.resumeEvents || []).map(function (r) {
      return '<div class="resume-note ' + r.kind + '">' + escapeHtml(r.note) + "</div>";
    }).join("");

    summaryContentEl.innerHTML = totalsHtml + tableHtml + resumeHtml;
    summaryPanelEl.hidden = false;
  }

  function loadSummary(featureId) {
    fetch("/api/features/" + encodeURIComponent(featureId) + "/summary")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (summary) { if (summary) renderSummary(summary); })
      .catch(function () {});
  }

  function connect(featureId) {
    if (currentSource) currentSource.close();
    resetStages();
    logEl.innerHTML = "";
    summaryPanelEl.hidden = true;
    summaryContentEl.innerHTML = "";
    sessionFeatureIdEl.textContent = featureId;
    startPanel.hidden = true;
    resumePanel.hidden = true;
    sessionPanel.hidden = false;

    currentSource = new EventSource("/api/features/" + encodeURIComponent(featureId) + "/stream");
    currentSource.onmessage = function (e) {
      var event = JSON.parse(e.data);
      appendLog(event);
      applyEventToStages(event);

      if (!event.parentSpanId && event.agentRole === "Director" && (event.event === "agent_end" || event.event === "error")) {
        loadSummary(featureId);
      }
    };
    currentSource.onerror = function () {};
  }

  function loadPendingFeatures() {
    fetch("/api/features")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var features = data.features || [];
        if (features.length === 0) {
          pendingListEl.innerHTML = '<p class="empty">No pending features.</p>';
          return;
        }
        var ul = document.createElement("ul");
        ul.className = "pending-list";
        features.forEach(function (f) {
          var li = document.createElement("li");
          var left = document.createElement("div");
          left.innerHTML =
            '<div class="title">' + escapeHtml(f.title) + "</div>" +
            '<div class="meta">' + escapeHtml(f.featureId) + " &middot; " + f.status + " &middot; " + f.currentStage + "</div>";
          var button = document.createElement("button");
          button.textContent = "Resume";
          button.addEventListener("click", function () { start({ featureId: f.featureId }); });
          li.appendChild(left);
          li.appendChild(button);
          ul.appendChild(li);
        });
        pendingListEl.innerHTML = "";
        pendingListEl.appendChild(ul);
      })
      .catch(function () {
        pendingListEl.innerHTML = '<p class="empty">Couldn\'t load pending features.</p>';
      });
  }

  function start(body) {
    fetch("/api/features", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { alert(data.error); return; }
        connect(data.featureId);
      })
      .catch(function () { alert("Couldn't reach the server."); });
  }

  startForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var task = taskInput.value.trim();
    if (!task) return;
    start({ task: task });
  });

  backButton.addEventListener("click", function () {
    if (currentSource) currentSource.close();
    sessionPanel.hidden = true;
    startPanel.hidden = false;
    resumePanel.hidden = false;
    taskInput.value = "";
    loadPendingFeatures();
  });

  loadPendingFeatures();
})();
```

- [ ] **Step 3: Rewrite `src/web/public/index.html`**

Replace the entire file with this (HTML structure only, `<link>` and `<script>` references instead of inline blocks):

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AI Dev Studio</title>
<link rel="stylesheet" href="style.css" />
</head>
<body>
<main>
  <h1>AI Dev Studio</h1>
  <p class="subtitle">PM &rarr; Architect &rarr; Dev &rarr; QA &rarr; DevOps, orchestrated by the Director &mdash; watched live.</p>

  <section class="panel" id="start-panel">
    <h2>Start a new feature</h2>
    <form id="start-form">
      <input type="text" id="task-input" placeholder="e.g. Add a CSV export endpoint" autocomplete="off" />
      <button type="submit">Start</button>
    </form>
  </section>

  <section class="panel" id="resume-panel">
    <h2>Resume a pending feature</h2>
    <div id="pending-list"><p class="empty">Loading&hellip;</p></div>
  </section>

  <section class="panel" id="session-panel" hidden>
    <div class="session-header">
      <h2 style="margin:0;">Live progress</h2>
      <code id="session-feature-id"></code>
    </div>
    <div class="stages" id="stage-badges"></div>
    <div class="log" id="log"></div>
    <div class="summary" id="summary-panel" hidden>
      <h3>Trace summary</h3>
      <div id="summary-content"></div>
    </div>
    <div style="margin-top:0.9rem;">
      <button type="button" class="secondary" id="back-button">&larr; Back</button>
    </div>
  </section>
</main>
<script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 4: Verify typecheck passes**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
git add src/web/public/
git commit -m "refactor: split index.html into index.html + style.css + app.js"
```

---

## Task 3: Create `pipeline.ts` — Types + Registry

**Files:**
- Create: `src/agents/director/pipeline.ts`

**Interfaces:**
- Consumes: `StageName` from `../../feature-state/store.js`
- Produces:
  - `StageContext` — `{ featureId: string; workspaceRoot: string; title: string; qaRetries: number }`
  - `StageOutcome` — `{ summary: string; artifact?: string; approved?: boolean }`
  - `StageDefinition` — `{ name: StageName; run: (ctx: StageContext) => Promise<StageOutcome> }`
  - `PIPELINE: StageDefinition[]` — ordered array of all five stages
  - `STAGE_ORDER: StageName[]` — derived from PIPELINE for convenience
  - `MAX_QA_RETRIES: 2`

- [ ] **Step 1: Create `src/agents/director/pipeline.ts`**

```ts
import type { StageName } from "../../feature-state/store.js";
import { pmStage } from "./stages/pm.js";
import { architectStage } from "./stages/architect.js";
import { devStage } from "./stages/dev.js";
import { qaStage } from "./stages/qa.js";
import { devopsStage } from "./stages/devops.js";

export const MAX_QA_RETRIES = 2;

export interface StageContext {
  featureId: string;
  workspaceRoot: string;
  title: string;
  qaRetries: number;
}

export interface StageOutcome {
  summary: string;
  artifact?: string;
  /** Only set by the QA stage. */
  approved?: boolean;
}

export interface StageDefinition {
  name: StageName;
  run: (ctx: StageContext) => Promise<StageOutcome>;
}

export const PIPELINE: StageDefinition[] = [
  pmStage,
  architectStage,
  devStage,
  qaStage,
  devopsStage,
];

/** Ordered list of stage names — derived from PIPELINE so they stay in sync. */
export const STAGE_ORDER: StageName[] = PIPELINE.map((s) => s.name);
```

Note: stage files don't exist yet — typecheck will fail until Task 4 is complete. That is expected.

- [ ] **Step 2: Commit (stages stub will be added in Task 4)**

Skip until after Task 4.

---

## Task 4: Create Stage Files

**Files:**
- Create: `src/agents/director/stages/pm.ts`
- Create: `src/agents/director/stages/architect.ts`
- Create: `src/agents/director/stages/dev.ts`
- Create: `src/agents/director/stages/qa.ts`
- Create: `src/agents/director/stages/devops.ts`

**Interfaces:**
- Consumes: `StageDefinition`, `StageOutcome`, `StageContext` from `../pipeline.js`
- Consumes: agent run functions from their respective modules
- Produces: one named `StageDefinition` export per file, consumed by `pipeline.ts`

- [ ] **Step 1: Create `src/agents/director/stages/pm.ts`**

```ts
import { runPmAgent } from "../../pm/agent.js";
import type { StageDefinition, StageOutcome } from "../pipeline.js";

export const pmStage: StageDefinition = {
  name: "PM",
  run: async (ctx): Promise<StageOutcome> => {
    const summary = await runPmAgent({
      featureId: ctx.featureId,
      workspaceRoot: ctx.workspaceRoot,
      task: `User request: "${ctx.title}". Write specs.md with a summary, scope, and acceptance criteria.`,
    });
    return { summary, artifact: "specs.md" };
  },
};
```

- [ ] **Step 2: Create `src/agents/director/stages/architect.ts`**

```ts
import { runArchitectAgent } from "../../architect/agent.js";
import type { StageDefinition, StageOutcome } from "../pipeline.js";

export const architectStage: StageDefinition = {
  name: "Architect",
  run: async (ctx): Promise<StageOutcome> => {
    const summary = await runArchitectAgent({
      featureId: ctx.featureId,
      workspaceRoot: ctx.workspaceRoot,
      task: `Read specs.md and design the technical architecture in design.md. Original request: "${ctx.title}".`,
    });
    return { summary, artifact: "design.md" };
  },
};
```

- [ ] **Step 3: Create `src/agents/director/stages/dev.ts`**

```ts
import { runDevAgent } from "../../dev/agent.js";
import type { StageDefinition, StageOutcome } from "../pipeline.js";

export const devStage: StageDefinition = {
  name: "Dev",
  run: async (ctx): Promise<StageOutcome> => {
    const task =
      ctx.qaRetries > 0
        ? "QA found issues — review qa-report.md in the workspace, fix them, and commit."
        : `Read specs.md and design.md, implement the feature, and commit with git. Original request: "${ctx.title}".`;
    const summary = await runDevAgent({
      featureId: ctx.featureId,
      workspaceRoot: ctx.workspaceRoot,
      task,
    });
    return { summary };
  },
};
```

- [ ] **Step 4: Create `src/agents/director/stages/qa.ts`**

```ts
import { runQaAgent, isQaApproved } from "../../qa/agent.js";
import type { StageDefinition, StageOutcome } from "../pipeline.js";

export const qaStage: StageDefinition = {
  name: "QA",
  run: async (ctx): Promise<StageOutcome> => {
    const summary = await runQaAgent({
      featureId: ctx.featureId,
      workspaceRoot: ctx.workspaceRoot,
      task: 'Review the code against specs.md and design.md. Write qa-report.md and end your reply with an exact line "VERDICT: APPROVED" or "VERDICT: FAILED".',
    });
    return { summary, artifact: "qa-report.md", approved: isQaApproved(summary) };
  },
};
```

- [ ] **Step 5: Create `src/agents/director/stages/devops.ts`**

```ts
import { runDevopsAgent } from "../../devops/agent.js";
import type { StageDefinition, StageOutcome } from "../pipeline.js";

export const devopsStage: StageDefinition = {
  name: "DevOps",
  run: async (ctx): Promise<StageOutcome> => {
    const summary = await runDevopsAgent({
      featureId: ctx.featureId,
      workspaceRoot: ctx.workspaceRoot,
      task: `Add an entry to CHANGELOG.md summarizing the feature "${ctx.title}" and make a final commit if needed.`,
    });
    return { summary, artifact: "CHANGELOG.md" };
  },
};
```

- [ ] **Step 6: Verify typecheck passes**

```bash
npm run typecheck
```

Expected: zero errors (pipeline.ts + all five stage files now resolve each other).

- [ ] **Step 7: Commit**

```bash
git add src/agents/director/pipeline.ts src/agents/director/stages/
git commit -m "refactor: extract pipeline types, registry, and stage definitions"
```

---

## Task 5: Create `pipeline-mechanics.ts`

**Files:**
- Create: `src/agents/director/pipeline-mechanics.ts`

**Interfaces:**
- Consumes:
  - `FeatureState`, `StageName` from `../../feature-state/store.js`
  - `updateFeatureState`, `FeatureStateToolsClient` from `../shared/feature-state-client.js`
  - `TraceLogger` from `../../observability/trace-logger.js`
  - `StageContext`, `StageDefinition`, `MAX_QA_RETRIES` from `./pipeline.js`
- Produces:
  - `resolveResumeIndex(feature: FeatureState, pipeline: StageDefinition[]): number`
  - `shouldSkipStage(stageName: StageName, feature: FeatureState): boolean`
  - `ExecuteStageOpts` interface
  - `ExecuteStageResult` type
  - `executeStage(stage, ctx, opts): Promise<ExecuteStageResult>`

- [ ] **Step 1: Create `src/agents/director/pipeline-mechanics.ts`**

```ts
import type { FeatureState, StageName } from "../../feature-state/store.js";
import { updateFeatureState, type FeatureStateToolsClient } from "../shared/feature-state-client.js";
import type { TraceLogger } from "../../observability/trace-logger.js";
import type { StageContext, StageDefinition } from "./pipeline.js";
import { MAX_QA_RETRIES } from "./pipeline.js";

export type ExecuteStageResult =
  | { action: "advance"; state: FeatureState }
  | { action: "retry"; toStageName: StageName; qaRetries: number; state: FeatureState }
  | { action: "blocked"; state: FeatureState };

export interface ExecuteStageOpts {
  featureId: string;
  featureClient: FeatureStateToolsClient;
  traceLogger: TraceLogger;
  directorCtx: { traceId: string; spanId: string; agentRole: string };
}

/**
 * Returns the index in `pipeline` where execution should start,
 * based on the feature's current stage. Clamps to 0 if not found.
 */
export function resolveResumeIndex(feature: FeatureState, pipeline: StageDefinition[]): number {
  const idx = pipeline.findIndex((s) => s.name === feature.currentStage);
  return Math.max(0, idx);
}

/**
 * Returns true if this stage is already done and should be skipped.
 * Used in the director loop to fast-forward past completed stages on resume.
 */
export function shouldSkipStage(stageName: StageName, feature: FeatureState): boolean {
  return feature.stages[stageName]?.status === "done";
}

/**
 * Executes one pipeline stage: marks it in_progress, calls stage.run(),
 * handles QA retry logic, marks it done or blocked, and returns an action
 * that tells the director loop what to do next.
 */
export async function executeStage(
  stage: StageDefinition,
  ctx: StageContext,
  opts: ExecuteStageOpts,
): Promise<ExecuteStageResult> {
  const { featureId, featureClient, traceLogger, directorCtx } = opts;

  await traceLogger.log({ ...directorCtx, event: "message", stage: stage.name, note: "starting stage" });
  let state = await updateFeatureState(featureClient, {
    featureId,
    currentStage: stage.name,
    status: "in_progress",
  });

  try {
    const outcome = await stage.run(ctx);

    if (stage.name === "QA" && !outcome.approved) {
      if (ctx.qaRetries >= MAX_QA_RETRIES) {
        state = await updateFeatureState(featureClient, {
          featureId,
          status: "blocked",
          stages: { QA: { status: "failed", notes: outcome.summary } },
        });
        await traceLogger.log({
          ...directorCtx,
          event: "agent_end",
          output: `Blocked: QA kept failing after ${ctx.qaRetries} retry(ies).`,
        });
        return { action: "blocked", state };
      }

      const newQaRetries = ctx.qaRetries + 1;
      state = await updateFeatureState(featureClient, {
        featureId,
        currentStage: "Dev",
        // Dev's status must be reset to in_progress so the loop doesn't
        // skip it due to the stages[stage]?.status === "done" check.
        stages: {
          Dev: { status: "in_progress" },
          QA: { status: "failed", notes: outcome.summary },
        },
        qaRetries: newQaRetries,
      });
      await traceLogger.log({
        ...directorCtx,
        event: "message",
        stage: "QA",
        note: `not approved, retry ${newQaRetries}/${MAX_QA_RETRIES}`,
      });
      return { action: "retry", toStageName: "Dev", qaRetries: newQaRetries, state };
    }

    state = await updateFeatureState(featureClient, {
      featureId,
      stages: { [stage.name]: { status: "done", artifact: outcome.artifact, notes: outcome.summary } },
    });
    return { action: "advance", state };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state = await updateFeatureState(featureClient, {
      featureId,
      status: "blocked",
      stages: { [stage.name]: { status: "failed", notes: message } },
    });
    await traceLogger.log({ ...directorCtx, event: "error", stage: stage.name, output: message });
    return { action: "blocked", state };
  }
}
```

- [ ] **Step 2: Verify typecheck passes**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/agents/director/pipeline-mechanics.ts
git commit -m "refactor: extract pipeline mechanics (retry, resume, error recovery)"
```

---

## Task 6: Rewrite `director.ts` as a Thin Loop

**Files:**
- Rewrite: `src/agents/director/director.ts`

**Interfaces:**
- Consumes:
  - `newSpanId`, `TraceLogger` from `../../observability/trace-logger.js`
  - `connectFeatureStateClient`, `getFeatureState`, `updateFeatureState`, `FeatureStateToolsClient` from `../shared/feature-state-client.js`
  - `generateFeatureId` from `./slugify.js`
  - `PIPELINE` from `./pipeline.js`
  - `resolveResumeIndex`, `shouldSkipStage`, `executeStage` from `./pipeline-mechanics.js`
- Produces:
  - `RunDirectorOptions` interface
  - `DirectorResult` interface
  - `runDirector(opts: RunDirectorOptions): Promise<DirectorResult>`
  - Re-exports: `STAGE_ORDER`, `MAX_QA_RETRIES` from `./pipeline.js` (keeps `run-studio.ts` import unchanged)
  - Re-exports: `FeatureStateToolsClient` type

- [ ] **Step 1: Replace `src/agents/director/director.ts` entirely**

```ts
/**
 * The Director: orchestrates the PM → Architect → Dev → QA → DevOps
 * pipeline for a feature, reading and updating its state in the Feature
 * State MCP (see ARCHITECTURE.md section 4) so it can be resumed if it
 * was left half-done.
 *
 * The Director is deliberately NOT itself an agent that calls Claude: it's
 * deterministic orchestration code that delegates each real work step to
 * an agent (PM/Architect/Dev/QA/DevOps), each of which does run its own
 * loop against the Messages API. This is a common multi-agent pattern (a
 * code supervisor, not an LLM, deciding the routing) and keeps the
 * Director easy to test without mocking the Anthropic API.
 *
 * Stage logic lives in stages/*.ts. Retry/resume/error mechanics live in
 * pipeline-mechanics.ts. Adding a new stage: create stages/<name>.ts and
 * add one entry to PIPELINE in pipeline.ts — nothing else changes here.
 */
import { newSpanId, TraceLogger } from "../../observability/trace-logger.js";
import {
  connectFeatureStateClient,
  getFeatureState,
  updateFeatureState,
  type FeatureStateToolsClient,
} from "../shared/feature-state-client.js";
import { generateFeatureId } from "./slugify.js";
import { PIPELINE } from "./pipeline.js";
import { resolveResumeIndex, shouldSkipStage, executeStage } from "./pipeline-mechanics.js";

export interface RunDirectorOptions {
  /** If given, resumes that feature (it must already exist). */
  featureId?: string;
  /** Required if featureId doesn't exist yet (creates the feature). */
  task?: string;
}

export interface DirectorResult {
  featureId: string;
  finalState: import("../../feature-state/store.js").FeatureState;
}

export async function runDirector(opts: RunDirectorOptions): Promise<DirectorResult> {
  if (!opts.featureId && !opts.task) {
    throw new Error("runDirector needs featureId (to resume) or task (to create a new feature).");
  }

  const traceLogger = new TraceLogger();
  const directorSpanId = newSpanId("agt_director");
  const featureId = opts.featureId ?? generateFeatureId(opts.task!);
  const directorCtx = { traceId: featureId, spanId: directorSpanId, agentRole: "Director" };

  const stateClient = await connectFeatureStateClient();
  const featureClient = stateClient as unknown as FeatureStateToolsClient;

  try {
    await traceLogger.log({ ...directorCtx, event: "agent_start", input: { featureId, task: opts.task } });

    let state = await getFeatureState(featureClient, featureId);
    const isResuming = state !== null;
    if (!state) {
      if (!opts.task) throw new Error(`Feature "${featureId}" doesn't exist and no task was given to create it.`);
      state = await updateFeatureState(featureClient, {
        featureId,
        title: opts.task,
        status: "in_progress",
        currentStage: "PM",
      });
    }

    // Phase 6 — robust resume: distinguish interrupted (crash/kill) from
    // blocked (agent threw or QA exhausted retries) so the trace is clear.
    if (isResuming && state.status !== "done") {
      const kind = state.status === "blocked" ? "blocked" : "interrupted";
      await traceLogger.log({
        ...directorCtx,
        event: "message",
        stage: state.currentStage,
        note:
          kind === "interrupted"
            ? `Resuming feature "${featureId}": it was interrupted mid-stage "${state.currentStage}" — continuing from there.`
            : `Resuming feature "${featureId}": it was blocked at stage "${state.currentStage}" — continuing from there.`,
        resumeKind: kind,
        qaRetries: state.qaRetries ?? 0,
      });
    }

    const workspaceRoot = `workspaces/${featureId}`;
    let qaRetries = state.qaRetries ?? 0;
    let stageIndex = resolveResumeIndex(state, PIPELINE);

    while (stageIndex < PIPELINE.length) {
      const stage = PIPELINE[stageIndex];

      if (shouldSkipStage(stage.name, state)) { stageIndex++; continue; }

      const ctx = { featureId, workspaceRoot, title: state.title, qaRetries };
      const result = await executeStage(stage, ctx, { featureId, featureClient, traceLogger, directorCtx });

      if (result.action === "blocked") return { featureId, finalState: result.state };

      if (result.action === "retry") {
        stageIndex = PIPELINE.findIndex((s) => s.name === result.toStageName);
        qaRetries = result.qaRetries;
        state = result.state;
        continue;
      }

      state = result.state;
      stageIndex++;
    }

    state = await updateFeatureState(featureClient, { featureId, status: "done" });
    await traceLogger.log({ ...directorCtx, event: "agent_end", output: "Pipeline complete." });
    return { featureId, finalState: state };
  } finally {
    await stateClient.close();
  }
}

// Re-export so existing consumers (run-studio.ts) keep their imports unchanged.
export { STAGE_ORDER, MAX_QA_RETRIES } from "./pipeline.js";
export type { FeatureStateToolsClient };
```

- [ ] **Step 2: Verify typecheck passes**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/agents/director/director.ts
git commit -m "refactor: rewrite director.ts as thin orchestration loop"
```

---

## Task 7: Final Verification

**Files:** none modified — read-only checks

- [ ] **Step 1: Typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 2: Run all test scripts that require no API key**

```bash
npm run test:store
npm run test:fs-git
npm run test:trace-logger
npm run test:agent-helpers
```

Each should exit with code 0 and print passing assertions.

- [ ] **Step 3: Run MCP client test (launches MCP server as subprocess)**

```bash
npm run test:mcp-client
```

Expected: exit code 0.

- [ ] **Step 4: Verify the scripts folder layout**

```bash
ls scripts/
ls scripts/__tests__/
```

Expected:
```
scripts/
  run-studio.ts  run-dev-agent.ts  run-web.ts  trace-summary.ts  __tests__/

scripts/__tests__/
  test-core.ts  test-agent-loop-helpers.ts  test-feature-state-client.ts
  test-feature-state-store.ts  test-filesystem-git-ops.ts  test-trace-logger.ts
```

- [ ] **Step 5: Verify the web/public folder layout**

```bash
ls src/web/public/
```

Expected: `index.html  style.css  app.js`

- [ ] **Step 6: Verify the director folder layout**

```bash
ls src/agents/director/
ls src/agents/director/stages/
```

Expected:
```
director/
  director.ts  pipeline.ts  pipeline-mechanics.ts  slugify.ts  stages/  __tests__/

stages/
  pm.ts  architect.ts  dev.ts  qa.ts  devops.ts
```

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "refactor: complete scripts/__tests__, index.html split, and director modularization"
```
