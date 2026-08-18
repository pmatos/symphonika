// Bundles src/client/issues-bulk.tsx (the /issues page's bulk-select React
// island) into dist/client/issues-bulk.js -- a single self-contained IIFE,
// React included, no CDN dependency. Served by GET /assets/issues-bulk.js
// (src/http/pages.ts), read from disk relative to the compiled module's own
// location so it works the same whether running from dist/ (prod) or via
// tsx from src/ (dev) -- see that route's own comment.
//
// Usage: node scripts/build-client.mjs   (or: npm run build:client)

import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const entryPoint = fileURLToPath(
  new URL("../src/client/issues-bulk.tsx", import.meta.url)
);
const outfile = fileURLToPath(
  new URL("../dist/client/issues-bulk.js", import.meta.url)
);

await build({
  bundle: true,
  entryPoints: [entryPoint],
  format: "iife",
  jsx: "automatic",
  logLevel: "info",
  minify: true,
  outfile,
  platform: "browser",
  sourcemap: true,
  target: "es2022"
});
