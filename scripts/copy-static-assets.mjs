// tsc compiles src/**/*.ts into dist/src/**/*.js but does not copy non-.ts
// assets. src/web/server.ts resolves its PUBLIC_DIR relative to its own
// compiled location (dist/src/web/), so the static files need to land there.
import { cp } from "node:fs/promises";

await cp("src/web/public", "dist/src/web/public", { recursive: true });
console.log("Copied src/web/public -> dist/src/web/public");
