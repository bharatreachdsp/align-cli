#!/usr/bin/env node
/**
 * Release checks the public CLI mirror's workflow runs (ALIGN L19), copied into the mirror as
 * `scripts/release-check.mjs`. Node built-ins only; prints one line, never a secret (there is none to print).
 *
 *   release-check.mjs <tag>                   the tag is `v<version>`; release.json and packages/cli/package.json name
 *                                             that version; release.json's server is an https origin (a release
 *                                             with no server baked in is refused)
 *   release-check.mjs --npm <version>         npm is 11.5.1 or later (trusted publishing needs it)
 *   release-check.mjs --strip-dev <manifest>  drops devDependencies and lifecycle scripts before `npm pack`
 *                                             (the bundle is already built; `workspace:` specifiers never ship)
 *   release-check.mjs --packed <tag> <manifest>
 *                                             the packed manifest (from the tarball) names the tag's version and
 *                                             has no devDependencies, scripts or `workspace:` specifiers
 *   release-check.mjs --integrity <file> <sha512-…>
 *                                             the file's SRI hash is the pinned one (npm itself, before install)
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;
const ORIGIN = /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/;

/** Throws with a one-line reason when the tag, the versions or the server disagree. */
export function checkTag(tag, release, manifest) {
  const version = String(manifest.version ?? "");
  if (!SEMVER.test(version)) throw new Error(`packages/cli/package.json has no semver version`);
  if (tag !== `v${version}`) throw new Error(`the tag ${tag} does not name packages/cli/package.json's ${version}`);
  if (release.version !== version) throw new Error(`release.json names ${release.version}, not ${version}`);
  const prerelease = version.includes("-");
  const want = prerelease ? "next" : "latest";
  if (release.distTag !== want || release.channel !== want)
    throw new Error(`release.json: ${version} goes out on ${want}`);
  if (typeof release.defaultServer !== "string" || !ORIGIN.test(release.defaultServer))
    throw new Error("release.json: no https server for this channel; nothing is published");
  return { version, distTag: want };
}

/** True when `v` is 11.5.1 or later. */
export function npmOk(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v).trim());
  if (!m) return false;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return a > 11 || (a === 11 && (b > 5 || (b === 5 && c >= 1)));
}

/** The manifest as published: no devDependencies, no lifecycle scripts. */
export function stripDev(manifest) {
  const out = { ...manifest };
  delete out.devDependencies;
  delete out.scripts;
  return out;
}

/** Throws unless the manifest packed into the tarball is the tag's version, with nothing that runs or resolves. */
export function checkPacked(tag, manifest) {
  if (tag !== `v${manifest.version}`) throw new Error(`the tarball holds ${manifest.version}, the tag is ${tag}`);
  if (manifest.scripts !== undefined || manifest.devDependencies !== undefined)
    throw new Error("the tarball's manifest still has scripts or devDependencies");
  if (JSON.stringify(manifest).includes('"workspace:'))
    throw new Error("the tarball's manifest has a workspace: specifier");
  return { version: String(manifest.version) };
}

/** True when `bytes` hash to the SRI string `sri` (sha512 only). */
export function integrityOk(bytes, sri) {
  const m = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(String(sri));
  return m !== null && createHash("sha512").update(bytes).digest("base64") === m[1];
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const [first, second] = process.argv.slice(2);
  try {
    if (first === "--npm") {
      if (!npmOk(second)) throw new Error(`npm ${second} is older than 11.5.1`);
      console.log(`release-check: npm ${second}`);
    } else if (first === "--strip-dev") {
      const p = resolve(second ?? "package.json");
      writeFileSync(p, `${JSON.stringify(stripDev(JSON.parse(readFileSync(p, "utf8"))), null, 2)}\n`);
      console.log("release-check: devDependencies and scripts removed");
    } else if (first === "--packed") {
      const r = checkPacked(second, JSON.parse(readFileSync(resolve(process.argv[4] ?? ""), "utf8")));
      console.log(`release-check: the tarball holds ${r.version}`);
    } else if (first === "--integrity") {
      if (!integrityOk(readFileSync(resolve(second ?? "")), process.argv[4])) throw new Error("integrity mismatch");
      console.log("release-check: integrity ok");
    } else if (first && !first.startsWith("--")) {
      const release = JSON.parse(readFileSync("release.json", "utf8"));
      const manifest = JSON.parse(readFileSync("packages/cli/package.json", "utf8"));
      const r = checkTag(first, release, manifest);
      console.log(`release-check: ${r.version} on ${r.distTag}`);
    } else {
      console.error(
        "usage: release-check.mjs <tag> | --npm <version> | --strip-dev <manifest> | --packed <tag> <manifest> | --integrity <file> <sri>",
      );
      process.exit(2);
    }
  } catch (err) {
    console.error(`release-check: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
