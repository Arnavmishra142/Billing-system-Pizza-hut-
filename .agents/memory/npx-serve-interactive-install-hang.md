---
name: npx serve interactive install hang
description: A workflow whose run command uses `npx <pkg>` can hang forever waiting on an interactive "Ok to proceed? (y)" prompt if node_modules isn't installed yet.
---

If a workflow's start command shells out via `npx <package>` (e.g. `npx serve . -l 5000`) and `node_modules` hasn't been installed, npx drops into an interactive "Need to install the following packages... Ok to proceed? (y)" prompt. The workflow has no TTY to answer it, so it hangs and eventually times out with "didn't open port".

**Why:** npx only auto-installs without prompting when the package is already present in `node_modules` (or `--yes` is passed); a bare `npx serve` in a fresh checkout falls back to the interactive confirmation.

**How to apply:** if a workflow using `npx <pkg>` fails to open its port, run `npm install` explicitly first (don't just retry the restart) — that pre-populates `node_modules` so `npx` resolves the binary locally without prompting.
