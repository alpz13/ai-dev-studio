/**
 * Minimal wrapper over the Anthropic TypeScript SDK (Messages API).
 * Roadmap phase 0: no agents or MCP yet, just testing the SDK.
 */
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

// The model is read from env so we don't hardcode a model id that could
// become outdated; check the current id at
// https://docs.claude.com/en/docs/about-claude/models before running it.
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5-20250929";

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic(); // reads ANTHROPIC_API_KEY from environment variables
  }
  return _client;
}

export interface MessageOptions {
  model?: string;
  system?: string;
  maxTokens?: number;
}

export async function sendMessage(prompt: string, opts: MessageOptions = {}): Promise<string> {
  const response = await getClient().messages.create({
    model: opts.model ?? DEFAULT_MODEL,
    max_tokens: opts.maxTokens ?? 1024,
    system: opts.system,
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  return textBlock?.type === "text" ? textBlock.text : "";
}

export async function streamMessage(
  prompt: string,
  onDelta: (text: string) => void,
  opts: MessageOptions = {},
): Promise<string> {
  const stream = getClient().messages.stream({
    model: opts.model ?? DEFAULT_MODEL,
    max_tokens: opts.maxTokens ?? 1024,
    system: opts.system,
    messages: [{ role: "user", content: prompt }],
  });

  stream.on("text", onDelta);
  const final = await stream.finalMessage();
  const textBlock = final.content.find((block) => block.type === "text");
  return textBlock?.type === "text" ? textBlock.text : "";
}
