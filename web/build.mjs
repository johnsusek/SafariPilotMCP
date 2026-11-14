import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { build } from "esbuild";

// A new identity per build, so a copy another build left registered never matches, even one of the same commit.
// The app extension reads build.json from its resources and the app from its embedded app extension.
let identity = `${new Date().toISOString().slice(0, 19).replace(/[-:]/g, "")}Z-${randomBytes(3).toString("hex")}`;
await writeFile(
  "../extension/build.json",
  `${JSON.stringify({ build: identity })}\n`,
);

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
// The console and network captures run in each frame's main world, beside the page's own scripts.
await build({
  ...shared,
  entryPoints: ["src/main/index.ts"],
  outfile: "../extension/main.js",
  format: "iife",
});
await build({
  ...shared,
  entryPoints: ["src/background/index.ts"],
  sourcemap: "inline",
  outfile: "../extension/background.js",
  format: "esm",
  define: { SAFARIPILOT_BUILD: JSON.stringify(identity) },
});
