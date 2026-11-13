import { build } from "esbuild";

let shared = {
  bundle: true,
  target: "safari17",
  logLevel: "info",
};

// The content script loads into every frame, ads included, so it carries no inline sourcemap.
await build({
  ...shared,
  entryPoints: ["src/content/index.ts"],
  outfile: "../extension/content.js",
  format: "iife",
});
// The console capture runs in each frame's main world, beside the page's own scripts.
await build({
  ...shared,
  entryPoints: ["src/main/index.ts"],
  outfile: "../extension/console.js",
  format: "iife",
});
await build({
  ...shared,
  entryPoints: ["src/background/index.ts"],
  sourcemap: "inline",
  outfile: "../extension/background.js",
  format: "esm",
});
