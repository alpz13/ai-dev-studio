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
