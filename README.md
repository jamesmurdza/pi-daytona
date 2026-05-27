# pi-daytona

Run the [Pi](https://pi.dev) coding agent's tools inside a remote, ephemeral
[Daytona](https://www.daytona.io) sandbox.

> **The agent's brain runs locally; its hands run in a remote container.**
> Pi, the LLM calls, the TUI, sessions, and settings stay on your machine.
> Only **tool execution** (`bash` + file I/O) is redirected into a clean,
> disposable Daytona container — so installs, builds, and destructive commands
> never touch your laptop.

This is a standalone Pi extension (no fork of Pi). It delegates Pi's pluggable
tool operations to a Daytona sandbox, modeled on the in-tree `ssh.ts` example.

## Install

```bash
pi install npm:pi-daytona
# or, straight from source:
pi install git:github.com/<you>/pi-daytona
# dev loop (no install):
pi -e ./index.ts --daytona --blank
```

## Auth

Set a Daytona API key (create one at <https://app.daytona.io>):

```bash
export DAYTONA_API_KEY=dtn_...
```

The SDK also honors `DAYTONA_API_URL` (default `https://app.daytona.io/api`)
and `DAYTONA_TARGET`. If `DAYTONA_API_KEY` is unset, the extension prompts for
it once per session (held in memory only — never persisted).

## Usage

```bash
pi --daytona --repo github.com/acme/api          # clone a repo into a fresh sandbox
pi --daytona --repo github.com/acme/api --branch dev
pi --daytona --blank                              # empty default sandbox; agent sets it up
pi --daytona --snapshot my-snapshot               # choose the base image/snapshot
pi --daytona --repo ... --public                  # public sandbox (browser-openable preview URLs)
```

While sandboxed, a footer badge shows the live status:

```
☁ daytona · 7f3a9b21 · running · /home/daytona/api
```

### Commands

- `/sandbox status` — id, state, working dir, snapshot, visibility
- `/sandbox url <port>` — preview URL for a served port (with the
  `x-daytona-preview-token` for private sandboxes)

## Lifecycle

The sandbox is **ephemeral**: created at launch, torn down on exit
(`sandbox.delete()`), and created with `ephemeral: true` so it is reaped if Pi
exits uncleanly. Daytona's own `autoStopInterval` (default 15 min idle) is a
further backstop.

## What runs where

| Pi tool | Backed by |
|---|---|
| `bash` (+ user `!`) | `sandbox.process.executeCommand` |
| `read` | `sandbox.fs.downloadFile` |
| `write` | `sandbox.fs.uploadFile` |
| `edit` | download → apply edits → upload (preserves Pi's exact-match semantics) |
| `ls` | `sandbox.fs` via shell (`test`, `ls -1A`) |
| `find` | `sandbox.fs.searchFiles` |
| `grep` | ripgrep/grep run **inside** the sandbox (Pi's grep runs `rg` locally, so it can't be redirected via operations) |

## Development

```bash
npm install
npm run check      # typecheck + load/registration smoke test
```

`npm run smoke` loads the extension via Pi's own jiti loader against a stub API
and asserts it registers all flags, tools, events, and commands — no Daytona
key or network required.

## Status

v1 is launch-scoped and ephemeral. Deferred: mirror-local-dir + sync-back,
persistence/reattach, mid-session backend flip, auto preview-URL detection,
interactive `/sandbox shell`, and sandboxed subagents.
