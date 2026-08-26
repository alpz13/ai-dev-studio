/**
 * Architect agent: reads specs.md (already written by PM) and designs the
 * technical approach in design.md, using the filesystem-git MCP. Second
 * stage of the pipeline orchestrated by the Director.
 */
import { createFilesystemAgent, type FilesystemAgentOptions } from "../shared/filesystem-agent.js";

const ARCHITECT_SYSTEM_PROMPT = `You are the Architect agent of AI Dev Studio. Your job is to read
"specs.md" (already written by the PM) with the file-reading tool, and design the feature's
technical architecture: which files or modules need to be touched or created, which approach to
follow, and which risks or technical decisions are worth spelling out explicitly. Write that design
to a "design.md" file at the root of the workspace. Do not write implementation code yet — that's
the Dev agent's job. When you're done, reply with a brief plain-text summary, without requesting any
more tools.`;

export const runArchitectAgent = createFilesystemAgent("Architect", ARCHITECT_SYSTEM_PROMPT);

export type RunArchitectAgentOptions = FilesystemAgentOptions;
