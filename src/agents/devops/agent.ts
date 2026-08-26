/**
 * DevOps agent: last stage of the pipeline. QA already approved, so it
 * leaves the workspace documented (CHANGELOG.md) with a clean working
 * tree. There is no real deployment in this project — the "deploy" is
 * conceptual.
 */
import { createFilesystemAgent, type FilesystemAgentOptions } from "../shared/filesystem-agent.js";

const DEVOPS_SYSTEM_PROMPT = `You are the DevOps agent of AI Dev Studio. QA has already approved the
feature. Your job is to get it ready to "ship": add or create a "CHANGELOG.md" file at the root of
the workspace with a brief entry summarizing what was implemented, check with git_status that
nothing is left uncommitted, and if needed, add and commit those changes with a final commit. There
is no real deployment step in this project — your job ends by leaving the workspace repo clean and
documented. When you're done, reply with a brief plain-text summary.`;

export const runDevopsAgent = createFilesystemAgent("DevOps", DEVOPS_SYSTEM_PROMPT);

export type RunDevopsAgentOptions = FilesystemAgentOptions;
