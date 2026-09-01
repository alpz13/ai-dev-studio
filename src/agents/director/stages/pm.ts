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
