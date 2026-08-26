/**
 * QA agent: reviews the Dev agent's code against specs.md/design.md using
 * the filesystem-git MCP (reading + git_diff), and ends its reply with an
 * explicit verdict that the Director parses to decide whether the pipeline
 * moves on to DevOps or goes back to Dev.
 */
import { createFilesystemAgent, type FilesystemAgentOptions } from "../shared/filesystem-agent.js";

export const QA_VERDICT_APPROVED = "VERDICT: APPROVED";
export const QA_VERDICT_FAILED = "VERDICT: FAILED";

const QA_SYSTEM_PROMPT = `You are the QA agent of AI Dev Studio. Your job is to review the code
written by the Dev agent against "specs.md" and "design.md" (read them first), using
list_dir/read_file to inspect the code and git_diff to see the latest changes. Write a
"qa-report.md" file at the root of the workspace explaining what you reviewed and what you found.
ALWAYS end your final reply with an exact line, on its own line: "${QA_VERDICT_APPROVED}" if the
code meets specs.md's acceptance criteria, or "${QA_VERDICT_FAILED}" if something is missing — in
that case explain clearly in qa-report.md what's missing so the Dev agent can fix it. Do not modify
the code yourself.`;

export const runQaAgent = createFilesystemAgent("QA", QA_SYSTEM_PROMPT);

export type RunQaAgentOptions = FilesystemAgentOptions;

export function isQaApproved(finalText: string): boolean {
  return new RegExp(QA_VERDICT_APPROVED, "i").test(finalText);
}
