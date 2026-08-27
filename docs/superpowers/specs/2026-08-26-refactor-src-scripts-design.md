# Refactor: Scripts Organization, index.html Decomposition, Director Extensibility

**Date:** 2026-08-26
**Branch:** refactor
**Scope:** `scripts/`, `web/public/`, `src/agents/director/`

---

## Goals

1. Mirror the `__tests__` convention already used across `src/` in the `scripts/` folder.
2. Split the monolithic `index.html` into separate HTML, CSS, and JS files.
3. Make `director.ts` open/closed: adding a pipeline stage requires creating one file and one line — no edits to the orchestration core.

---

## Section 1: Scripts Reorganization

### Problem

Test scripts (`test-*.ts`) and runner scripts (`run-*.ts`, `trace-summary.ts`) sit flat in `scripts/`. Every other module in the project colocates tests under `__tests__/`; scripts is the only exception.

### Design

Move all `test-*.ts` files into `scripts/__tests__/`. No logic changes.

**Before:**
```
scripts/
├── run-studio.ts
├── run-dev-agent.ts
├── run-web.ts
├── trace-summary.ts
├── test-core.ts
├── test-agent-loop-helpers.ts
├── test-feature-state-client.ts
├── test-feature-state-store.ts
├── test-filesystem-git-ops.ts
└── test-trace-logger.ts
```

**After:**
```
scripts/
├── run-studio.ts
├── run-dev-agent.ts
├── run-web.ts
├── trace-summary.ts
└── __tests__/
    ├── test-core.ts
    ├── test-agent-loop-helpers.ts
    ├── test-feature-state-client.ts
    ├── test-feature-state-store.ts
    ├── test-filesystem-git-ops.ts
    └── test-trace-logger.ts
```

### Changes Required

- Move 6 `test-*.ts` files into `scripts/__tests__/`.
- Update all `test:*` entries in `package.json` to point to the new paths.

---

## Section 2: `index.html` Decomposition

### Problem

`web/public/index.html` (395 lines) embeds CSS in a `<style>` block and JavaScript in a `<script>` block. Editing styles requires scrolling past markup; editing JS requires scrolling past both. There is no separation between concerns within the file.

### Design

Extract CSS and JS into sibling files. The HTML file becomes structure-only.

**Before:**
```
web/public/
└── index.html   ← 395 lines (HTML + <style> + <script>)
```

**After:**
```
web/public/
├── index.html   ← HTML structure only (~80 lines)
├── style.css    ← all CSS from the <style> block
└── app.js       ← all JS from the <script> block (SSE client, rendering, event handlers)
```

### Changes Required

- Extract `<style>` content → `style.css`; replace block with `<link rel="stylesheet" href="style.css">`.
- Extract `<script>` content → `app.js`; replace block with `<script src="app.js"></script>`.
- No changes to `web/server.ts` — it already serves all files under `public/` as static assets.

---

## Section 3: `director.ts` Extensibility Refactor

### Problem

`director.ts` (248 lines) conflates four responsibilities:
1. **Pipeline orchestration** — which stages run in what order.
2. **Stage execution** — per-stage logic (calling the right agent, updating state).
3. **QA retry mechanics** — retry loop with `MAX_QA_RETRIES`.
4. **Resume/error recovery** — detecting blocked/interrupted state, finding where to restart.

Adding a new stage today means editing `director.ts` in multiple places. Changing retry logic risks breaking stage transitions.

### Design

Split into four focused modules under `agents/director/`:

```
agents/director/
├── director.ts            ← ~60 lines: entry point, drives the loop
├── pipeline.ts            ← StageDefinition interface, StageName type, PIPELINE array
├── pipeline-mechanics.ts  ← runStage(), runQaRetryLoop(), resolveResumeIndex(), error recovery
├── slugify.ts             ← unchanged
└── stages/
    ├── pm.ts
    ├── architect.ts
    ├── dev.ts
    ├── qa.ts
    └── devops.ts
```

### `pipeline.ts` — Contract + Registry

Defines the types and the ordered stage list. This is the only file touched when adding a stage.

```ts
export type StageName = 'pm' | 'architect' | 'dev' | 'qa' | 'devops';

export interface StageContext {
  featureId: string;
  feature: FeatureState;
  anthropic: Anthropic;
  traceLogger: TraceLogger;
  store: FeatureStateStore;
}

export interface StageDefinition {
  name: StageName;
  run: (ctx: StageContext) => Promise<void>;
}

export const PIPELINE: StageDefinition[] = [
  pmStage,
  architectStage,
  devStage,
  qaStage,
  devopsStage,
];
```

### `pipeline-mechanics.ts` — How Stages Run

All "execution policy" logic extracted from `director.ts`:

| Function | Responsibility |
|---|---|
| `resolveResumeIndex(feature, pipeline)` | Returns the index to start from when resuming a blocked/interrupted feature |
| `runStage(stage, ctx)` | Executes one stage: updates feature state before/after, handles stage-level errors |
| `runQaRetryLoop(ctx)` | QA-specific retry cycle (currently ~40 lines inline in director) |
| `recoverFromError(err, stage, ctx)` | Classifies errors, updates feature state to `blocked` or rethrows |

### `stages/*.ts` — Per-Stage Logic

Each file exports one `StageDefinition`. Contains the agent call logic currently inlined per-stage in `director.ts`.

```ts
// stages/pm.ts
export const pmStage: StageDefinition = {
  name: 'pm',
  run: async (ctx) => {
    // PM agent invocation logic
  },
};
```

### `director.ts` After — The Loop

```ts
export async function runPipeline(featureId: string, description: string) {
  // setup: store, traceLogger, anthropic, feature state
  const startIndex = resolveResumeIndex(feature, PIPELINE);
  for (const stage of PIPELINE.slice(startIndex)) {
    await runStage(stage, ctx);
  }
}
```

### Adding a New Stage (Post-Refactor)

1. Create `stages/newstage.ts` implementing `StageDefinition`.
2. Add one entry to `PIPELINE` in `pipeline.ts`.

No other files change.

### Changes Required

- Create `pipeline.ts` with `StageDefinition`, `StageContext`, `StageName`, `PIPELINE`.
- Create `pipeline-mechanics.ts` with the four functions above, extracted from `director.ts`.
- Create `stages/pm.ts`, `stages/architect.ts`, `stages/dev.ts`, `stages/qa.ts`, `stages/devops.ts` with logic extracted from `director.ts`.
- Rewrite `director.ts` to use the above modules (~60 lines).
- Update imports in anything that currently imports from `director.ts` (primarily `scripts/run-studio.ts`).

---

## Testing

No new tests are introduced — this is a pure refactor. Existing behavior is preserved exactly. After the refactor:

- All `npm run test:*` scripts must pass (paths updated for `__tests__` move).
- `npm run typecheck` must pass with zero errors.
- `npm run agent:dev` end-to-end behavior must be unchanged.
- The web UI must load correctly with the split static files.

---

## File Change Summary

| File | Action |
|---|---|
| `scripts/test-*.ts` (6 files) | Move to `scripts/__tests__/` |
| `package.json` | Update `test:*` paths |
| `web/public/index.html` | Extract CSS + JS, add `<link>` and `<script>` tags |
| `web/public/style.css` | New — extracted CSS |
| `web/public/app.js` | New — extracted JS |
| `agents/director/director.ts` | Rewrite to ~60-line loop |
| `agents/director/pipeline.ts` | New — types + PIPELINE array |
| `agents/director/pipeline-mechanics.ts` | New — runStage, retry, resume, error recovery |
| `agents/director/stages/pm.ts` | New — PM stage definition |
| `agents/director/stages/architect.ts` | New — Architect stage definition |
| `agents/director/stages/dev.ts` | New — Dev stage definition |
| `agents/director/stages/qa.ts` | New — QA stage definition |
| `agents/director/stages/devops.ts` | New — DevOps stage definition |
