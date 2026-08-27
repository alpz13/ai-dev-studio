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
