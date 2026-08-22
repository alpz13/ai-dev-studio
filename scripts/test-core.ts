/**
 * Manual test of the Messages API wrapper. Requires ANTHROPIC_API_KEY in
 * .env (copy .env.example) and `npm install` done.
 *
 * Usage: npm run test:core
 */
import { sendMessage, streamMessage } from "../src/core/client.js";

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "Missing ANTHROPIC_API_KEY. Copy .env.example to .env and set your API key before running this.",
    );
    process.exit(1);
  }

  console.log("== sendMessage (no streaming) ==");
  const reply = await sendMessage("Answer in one sentence: what is the Model Context Protocol?");
  console.log(reply);

  console.log("\n== streamMessage (with streaming) ==");
  process.stdout.write("> ");
  await streamMessage("Count from 1 to 5, one number per line.", (chunk) => {
    process.stdout.write(chunk);
  });
  console.log("\n\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
