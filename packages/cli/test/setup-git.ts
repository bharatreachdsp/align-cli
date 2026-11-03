// Every installed hook runs through the shim, which exports ALIGN_GIT: the git `align init` found on PATH (shim.ts,
// findGit). In-process tests skip the shim, so without this the hooks fall back to /usr/bin/git, which on macOS is
// the xcrun wrapper: slow enough on GitHub's runners to pass the hooks' 300 ms git budget, so they skip git (cli-v0.1.2's
// macOS jobs). Set it the way init records it; a test that sets ALIGN_GIT itself still wins.
import { execFileSync } from "node:child_process";
import { findGit } from "../src/shim";

if (!process.env.ALIGN_GIT) {
  const git = findGit(process.env.PATH);
  if (git) process.env.ALIGN_GIT = git;
}

// On macOS, run each git once with no time limit before any hook does: xcrun's first lookup is slow, and a hook's
// 300 ms limit kills it before it caches the answer (#238 review). Prints how long each took, for the run's log.
if (process.platform === "darwin") {
  for (const git of new Set(["/usr/bin/git", process.env.ALIGN_GIT ?? ""].filter(Boolean))) {
    const t0 = Date.now();
    try {
      execFileSync(git, ["--version"], { stdio: "ignore", timeout: 60_000 });
    } catch {
      // absent or broken: the tests report what that means
    }
    process.stderr.write(`setup-git: ${git} --version ${Date.now() - t0} ms\n`);
  }
}
