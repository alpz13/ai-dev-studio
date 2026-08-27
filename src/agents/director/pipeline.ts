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
