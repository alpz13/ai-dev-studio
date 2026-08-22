/**
 * Pure persistence logic for feature state.
 *
 * Deliberately has NO dependency on MCP or any network layer: this allows
 * isolated testing (see scripts/test-feature-state-store.ts) and reuse
 * from any transport (MCP today, something else tomorrow).
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export type StageName = "PM" | "Architect" | "Dev" | "QA" | "DevOps";
export type StageStatus = "pending" | "in_progress" | "done" | "failed";
export type FeatureStatus = "pending" | "in_progress" | "blocked" | "done";

export interface StageInfo {
  status: StageStatus;
  artifact?: string;
  notes?: string;
}

export interface FeatureState {
  featureId: string;
  title: string;
  status: FeatureStatus;
  currentStage: StageName;
  stages: Partial<Record<StageName, StageInfo>>;
  updatedAt: string;
}

export interface UpdateFeatureStateInput {
  featureId: string;
  title?: string;
  status?: FeatureStatus;
  currentStage?: StageName;
  stages?: Partial<Record<StageName, StageInfo>>;
}

export function resolveFeaturesDir(baseDir = process.env.FEATURES_DIR ?? "features"): string {
  return path.isAbsolute(baseDir) ? baseDir : path.resolve(process.cwd(), baseDir);
}

export class FeatureStateStore {
  constructor(private readonly featuresDir: string = resolveFeaturesDir()) {}

  private statePath(featureId: string): string {
    return path.join(this.featuresDir, featureId, "state.json");
  }

  async ensureDir(): Promise<void> {
    await fs.mkdir(this.featuresDir, { recursive: true });
  }

  async readState(featureId: string): Promise<FeatureState | null> {
    try {
      const raw = await fs.readFile(this.statePath(featureId), "utf-8");
      return JSON.parse(raw) as FeatureState;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async writeState(state: FeatureState): Promise<FeatureState> {
    const dir = path.join(this.featuresDir, state.featureId);
    await fs.mkdir(dir, { recursive: true });
    const toWrite: FeatureState = { ...state, updatedAt: new Date().toISOString() };
    await fs.writeFile(this.statePath(state.featureId), JSON.stringify(toWrite, null, 2), "utf-8");
    return toWrite;
  }

  /** Creates the feature if it does not exist, or shallow-merges the given fields if it already does. */
  async upsertState(input: UpdateFeatureStateInput): Promise<FeatureState> {
    const existing = await this.readState(input.featureId);

    const base: FeatureState = existing ?? {
      featureId: input.featureId,
      title: input.title ?? input.featureId,
      status: "pending",
      currentStage: "PM",
      stages: {},
      updatedAt: new Date().toISOString(),
    };

    const merged: FeatureState = {
      ...base,
      title: input.title ?? base.title,
      status: input.status ?? base.status,
      currentStage: input.currentStage ?? base.currentStage,
      stages: { ...base.stages, ...input.stages },
    };

    return this.writeState(merged);
  }

  async listFeatures(): Promise<FeatureState[]> {
    await this.ensureDir();
    const entries = await fs.readdir(this.featuresDir, { withFileTypes: true });
    const states: FeatureState[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const state = await this.readState(entry.name);
      if (state) states.push(state);
    }
    return states;
  }

  async listPending(): Promise<FeatureState[]> {
    const all = await this.listFeatures();
    return all.filter((f) => f.status !== "done");
  }
}
