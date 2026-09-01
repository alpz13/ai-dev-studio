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
