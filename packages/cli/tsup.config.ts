import { defineConfig } from "tsup";

/**
 * One self-contained ESM file (docs/15): `@align/core`, commander and zod are all inlined, so the bundle
 * runs on its own after `init` copies it to `~/.align/lib/` and the package has no runtime dependencies.
 * `ALIGN_DEFAULT_SERVER` is baked in at build time (docs/04 §Environment). A release build (`ALIGN_RELEASE=1`,
 * or `npm pack`/`npm publish` through `prepack`) refuses to build without it, or with anything but an https
 * URL, so a published bundle can never point at a developer's machine. Other builds (CI, lanes) default to the
 * local dev server. No source maps ship.
 */
const defaultServer = process.env.ALIGN_DEFAULT_SERVER ?? "";
const release = process.env.ALIGN_RELEASE === "1" || process.env.npm_lifecycle_event === "prepack";
if (release && !/^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(defaultServer)) {
  throw new Error("release build: ALIGN_DEFAULT_SERVER must be set to the https origin of the server");
}

export default defineConfig({
  entry: { align: "src/align.ts" },
  format: ["esm"],
  outExtension: () => ({ js: ".mjs" }),
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: false,
  noExternal: [/.*/],
  define: {
    __ALIGN_DEFAULT_SERVER__: JSON.stringify(defaultServer),
    __ALIGN_DEV_SERVER__: JSON.stringify(release ? "" : "http://localhost:3000"),
  },
  // Folds the constant conditions above, so a release bundle holds only the baked server.
  esbuildOptions(options) {
    options.minifySyntax = true;
  },
  banner: { js: "#!/usr/bin/env node" },
});
