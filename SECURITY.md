# Security

Please report a vulnerability privately: on this repository's **Security** tab, choose **Report a
vulnerability** (GitHub's private reporting). Do not open a public issue for it.

Tell us what you found and how to reproduce it. We reply on the report, keep you informed until it is fixed, and
credit you in the release notes if you want.

What is in scope: this package (`@align-agent/cli`), including what it sends from your laptop, how it stores the
sign-in token, and the hooks it installs into Claude Code, Cursor and Codex.

Releases are published only by this repository's `publish` workflow with npm's trusted publishing; no npm token
exists. Every release from `0.1.4` on has a provenance statement linking it to a commit and workflow run here;
one without it is not ours. The only exception is `0.0.0`, an empty, deprecated placeholder that reserved the name.
