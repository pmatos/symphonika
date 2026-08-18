// Bundles each src/client/*.tsx entry point into its own self-contained IIFE
// under dist/client/ -- React (and, for issues-deps-graph, cytoscape)
// included, no CDN dependency. esbuild names each output file after its
// entry point's basename (issues-bulk.tsx -> issues-bulk.js), so adding an
// entry here doesn't change any existing output path. Served by the
// matching GET /assets/*.js route in src/http/pages.ts, read from disk
// relative to the compiled module's own location so it works the same
// whether running from dist/ (prod) or via tsx from src/ (dev) -- see that
// route's own comment.
//
// Usage: node scripts/build-client.mjs   (or: npm run build:client)

import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const entryPoints = ["issues-bulk.tsx", "issues-deps-graph.tsx"].map((name) =>
  fileURLToPath(new URL(`../src/client/${name}`, import.meta.url))
);
const outdir = fileURLToPath(new URL("../dist/client", import.meta.url));

await build({
  bundle: true,
  entryPoints,
  format: "iife",
  jsx: "automatic",
  logLevel: "info",
  minify: true,
  outdir,
  platform: "browser",
  sourcemap: true,
  target: "es2022"
});
