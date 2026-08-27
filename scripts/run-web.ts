/**
 * Web UI launcher — Phase 5: same Director pipeline as `npm run studio`,
 * watched live from a browser instead of the terminal.
 *
 * Usage:
 *   npm run web
 *   WEB_PORT=4000 npm run web
 */
import { startWebServer } from "../src/web/server.js";

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Missing ANTHROPIC_API_KEY. Copy .env.example to .env and set your API key.");
    process.exit(1);
  }

  const { port } = await startWebServer();
  console.log(`AI Dev Studio web UI running at http://localhost:${port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
