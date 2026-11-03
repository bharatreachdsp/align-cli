import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

type Manifest = {
  files?: string[];
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  gypfile?: boolean;
  scripts?: Record<string, string>;
};

const require = createRequire(import.meta.url);
const root = join(dirname(new URL(import.meta.url).pathname), "..");
const read = (path: string): Manifest => JSON.parse(readFileSync(path, "utf8"));

/** Every package the CLI installs for its users, transitively. */
function runtimeClosure(): string[] {
  const seen = new Map<string, string>();
  const visit = (manifestPath: string) => {
    const m = read(manifestPath);
    const req = createRequire(manifestPath);
    for (const name of Object.keys({ ...m.dependencies, ...m.optionalDependencies })) {
      if (seen.has(name)) continue;
      const pkg = req.resolve(`${name}/package.json`);
      seen.set(name, pkg);
      visit(pkg);
    }
  };
  visit(join(root, "package.json"));
  return [...seen.values()];
}

describe("@align-agent/cli package", () => {
  it("installs no native module (docs/04: no node-gyp)", () => {
    for (const manifest of runtimeClosure()) {
      const m = read(manifest);
      expect(m.gypfile, manifest).not.toBe(true);
      expect(existsSync(join(dirname(manifest), "binding.gyp")), manifest).toBe(false);
      expect(m.scripts?.install ?? "", manifest).not.toMatch(/node-gyp|prebuild/);
    }
  });

  it("runs no lifecycle script on install, its own or any dependency's", () => {
    const LIFECYCLE = ["preinstall", "install", "postinstall", "preprepare", "prepare", "postprepare"];
    for (const manifest of [join(root, "package.json"), ...runtimeClosure()]) {
      const scripts = Object.keys(read(manifest).scripts ?? {});
      expect(
        scripts.filter((s) => LIFECYCLE.includes(s)),
        manifest,
      ).toEqual([]);
    }
  });

  it("bundles @align/core instead of depending on it", () => {
    const m = read(join(root, "package.json"));
    expect(Object.keys(m.dependencies ?? {})).not.toContain("@align/core");
    // `/brand`: the mirror's core keeps only the exports the CLI reaches, and every build reaches this one.
    expect(require.resolve("@align/core/brand")).toContain("packages/core");
  });

  it("ships one bundle and nothing else, and has no runtime dependencies (docs/15)", () => {
    const m = read(join(root, "package.json"));
    expect(m.files).toEqual(["dist/align.mjs", "LICENSE", "README.md"]);
    expect(m.dependencies ?? {}).toEqual({});
    expect(m.optionalDependencies ?? {}).toEqual({});
    expect(Object.keys(m.scripts ?? {}).filter((s) => /install|prepare/.test(s))).toEqual([]);
  });

  it("a release build refuses to bake in no server or a non-https one, and never ships localhost", {
    timeout: 60_000,
  }, () => {
    const out = mkdtempSync(join(tmpdir(), "align-release-"));
    const build = (server: string | undefined) =>
      spawnSync("pnpm", ["exec", "tsup", "--out-dir", out], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, ALIGN_RELEASE: "1", ALIGN_DEFAULT_SERVER: server ?? "" },
      });
    try {
      expect(build(undefined).status).not.toBe(0);
      expect(build("http://localhost:3000").status).not.toBe(0);
      expect(build("https://staging.example.com").status).toBe(0);
      const bundle = readFileSync(join(out, "align.mjs"), "utf8");
      expect(bundle).toContain('"https://staging.example.com"');
      expect(bundle).not.toContain("localhost:3000");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
