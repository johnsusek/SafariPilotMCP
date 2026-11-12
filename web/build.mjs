import { build } from "esbuild";

let shared = {
  bundle: true,
  target: "safari17",
  sourcemap: "inline",
  logLevel: "info",
};

await build({
  ...shared,
  entryPoints: ["src/content/index.ts"],
  outfile: "../extension/content.js",
  format: "iife",
});
await build({
  ...shared,
  entryPoints: ["src/background/index.ts"],
  outfile: "../extension/background.js",
  format: "esm",
});
