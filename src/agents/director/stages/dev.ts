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
