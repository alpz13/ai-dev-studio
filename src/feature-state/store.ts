/**
 * Pure persistence logic for a feature's state.
 *
 * Deliberately does NOT depend on MCP or anything network-related: this way
 * it can be tested in isolation (see scripts/test-feature-state-store.ts) and
 * can be reused from any transport (MCP today, something else tomorrow).
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
  /**
   * Phase 6 — robust resume: how many times QA has already sent this
   * feature back to Dev. Persisted (not just kept as a local variable in
   * runDirector) so that resuming a feature that was interrupted mid
   * QA-retry-cycle sends Dev the "QA found issues" task again instead of
   * silently reverting to the original "implement the feature" task.
   */
  qaRetries?: number;
  updatedAt: string;
}

export interface UpdateFeatureStateInput {
  featureId: string;
  title?: string;
  status?: FeatureStatus;
  currentStage?: StageName;
  stages?: Partial<Record<StageName, StageInfo>>;
  qaRetries?: number;
}

const LOCK_STALE_MS = 30 * 60 * 1000; // 30 minutes — long enough to cover a full pipeline run, short enough that a crashed lock doesn't block a feature indefinitely.

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
    const finalPath = this.statePath(state.featureId);
    const tmpPath = `${finalPath}.tmp`;
    // Write to a temp file, then rename over the real path: rename() is
    // atomic on the same filesystem on both POSIX and Windows, so a crash
    // or failure mid-write can never leave state.json truncated/corrupt.
    await fs.writeFile(tmpPath, JSON.stringify(toWrite, null, 2), "utf-8");
    await fs.rename(tmpPath, finalPath);
    return toWrite;
  }

  private lockPath(featureId: string): string {
    return path.join(this.featuresDir, featureId, ".lock");
  }

  private ownerPath(featureId: string): string {
    return path.join(this.lockPath(featureId), "owner.json");
  }

  private async isLockStale(featureId: string): Promise<boolean> {
    try {
      const stat = await fs.stat(this.lockPath(featureId));
      return Date.now() - stat.mtimeMs > LOCK_STALE_MS;
    } catch {
      // Lock directory vanished between our EEXIST and this stat (released
      // concurrently by its owner) — nothing to reclaim; the mkdir retry
      // below will succeed normally.
      return true;
    }
  }

  /**
   * Atomic mutex via mkdir, which fails with EEXIST if the directory
   * already exists — no locking library needed. Returns false if another
   * run already holds the lock for this featureId. A lock directory older
   * than LOCK_STALE_MS is treated as abandoned (the holder crashed or was
   * killed without releasing it) and reclaimed automatically, so a
   * container restart never permanently blocks a feature.
   *
   * Staleness is judged by the lock directory's own mtime (set atomically
   * by mkdir), not by reading owner.json — a lock is briefly EEXIST-losable
   * by a second caller before its owner finishes writing owner.json, and
   * judging staleness from that file's presence/content would misjudge a
   * lock that is merely a few milliseconds old as abandoned.
   *
   * Reclaiming a stale lock uses fs.rename as the atomic claim step: if two
   * callers race to reclaim the same stale lock, only one rename succeeds —
   * the loser gets ENOENT and backs off (returns false) instead of forcing
   * through, so the mutex holds even during reclaim.
   */
  async acquireLock(featureId: string): Promise<boolean> {
    await fs.mkdir(path.join(this.featuresDir, featureId), { recursive: true });
    try {
      await fs.mkdir(this.lockPath(featureId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (!(await this.isLockStale(featureId))) return false;

      const claimPath = `${this.lockPath(featureId)}.stale-${process.pid}-${Date.now()}`;
      try {
        await fs.rename(this.lockPath(featureId), claimPath);
      } catch (renameErr) {
        if ((renameErr as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw renameErr;
      }
      await fs.rm(claimPath, { recursive: true, force: true }).catch((cleanupErr) => {
        console.error(`[feature-state] failed to clean up reclaimed stale lock at ${claimPath}:`, cleanupErr);
      });

      try {
        await fs.mkdir(this.lockPath(featureId));
      } catch (retryErr) {
        if ((retryErr as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw retryErr;
      }
    }
    await fs.writeFile(this.ownerPath(featureId), JSON.stringify({ pid: process.pid, startedAt: Date.now() }), "utf-8");
    return true;
  }

  async releaseLock(featureId: string): Promise<void> {
    await fs.rm(this.lockPath(featureId), { recursive: true, force: true });
  }

  /** Creates the feature if it doesn't exist, or shallow-merges the given fields if it does. */
  async upsertState(input: UpdateFeatureStateInput): Promise<FeatureState> {
    const existing = await this.readState(input.featureId);

    const base: FeatureState = existing ?? {
      featureId: input.featureId,
      title: input.title ?? input.featureId,
      status: "pending",
      currentStage: "PM",
      stages: {},
      qaRetries: 0,
      updatedAt: new Date().toISOString(),
    };

    const merged: FeatureState = {
      ...base,
      title: input.title ?? base.title,
      status: input.status ?? base.status,
      currentStage: input.currentStage ?? base.currentStage,
      stages: { ...base.stages, ...input.stages },
      qaRetries: input.qaRetries ?? base.qaRetries ?? 0,
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
