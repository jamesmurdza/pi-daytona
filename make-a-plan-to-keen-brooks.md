# UX Plan: Daytona Sandboxes in Pi

## Context

Pi is a local coding-agent CLI. Today every tool the agent runs — `bash`, `read`, `write`, `edit`, `grep`, `find`, `ls` — executes against the **host machine's** shell and filesystem. That means destructive commands, dependency installs, and builds all happen on the user's laptop, with the host's OS, toolchain, and risk profile.

**Daytona sandboxes** are remote, ephemeral Linux containers that boot in ~1s and expose an SDK for running commands, transferring files, doing git operations, and serving ports via preview URLs. Integrating them lets Pi run the agent's work in a **clean, isolated, reproducible remote environment** while the user keeps driving from their local terminal.

**Why this is a strong fit:** Pi's tool layer is already designed for pluggable backends. Every built-in tool takes an `*Operations` interface (`BashOperations`, `ReadOperations`, `WriteOperations`, `EditOperations`, `GrepOperations`, `FindOperations`, `LsOperations`) instead of calling `fs`/`spawn` directly. The shipped `examples/extensions/ssh.ts` already delegates all of these to a remote machine over SSH — Daytona is the same shape with a managed-container backend instead of raw SSH.

**Intended outcome:** A user can launch (or flip an existing session) into a Daytona sandbox, watch the agent operate entirely inside that container, and tear it down — without leaving the Pi TUI. This document specifies the **user experience only**; implementation is deferred.

**Distribution decision:** This ships as a **new standalone repository** — a third-party Pi extension package installed via `pi install`. We do **not** fork or modify the Pi monorepo. Pi's extension system is explicitly built for this: the public npm package `@earendil-works/pi-coding-agent` exports everything an extension needs (`ExtensionAPI`, event types, tool factories), and `ssh.ts` is a complete in-tree precedent for the exact pattern we need.

---

## Intended user experience

### End-to-end user journey (the recommended method)

A walkthrough of the v1 flow — a developer working on a repo inside a fresh, ephemeral sandbox:

**0. One-time setup.** User installs the extension (`pi install npm:pi-daytona`). Auth uses a `DAYTONA_API_KEY` environment variable (the same env-var pattern the custom-provider examples use — there is **no** extension-writable secrets vault). This maps cleanly onto the SDK: `new Daytona()` auto-reads `DAYTONA_API_KEY` (and optionally `DAYTONA_API_URL`, default `https://app.daytona.io/api`, and `DAYTONA_TARGET`, e.g. `us`) from the environment, so no explicit config object is required. If the env var is missing on first use, the extension prompts for it once via `ctx.ui.input` and passes it through `new Daytona({ apiKey })` for that session.

**1. Launch.** From their terminal:
```bash
pi --daytona --repo github.com/acme/api    # or: pi --daytona --blank
```

**2. Boot (≈1s).** The TUI opens as normal, with a spinner line: `☁  Spinning up Daytona sandbox…`. Behind it, a container is created, the repo is cloned server-side, and the working dir is set to the cloned path.

**3. Ready.** A transient notice appears — `Sandbox ready · sb-7f3a · 1.2s` — and a **persistent footer status** stays visible: `☁ daytona · sb-7f3a · running · /home/daytona/api`. The footer badge is the single, always-visible signal that work is remote; the rest of the chat UX is unchanged.

**4. The agent works remotely.** User types: *"Get the test suite passing."* The agent runs `ls`, `cat`, `npm install`, `npm test`, edits files — **all inside the sandbox**. The host filesystem is never touched.

**5. Seeing results.** The agent starts a dev server. The user runs `/sandbox url 3000` and gets the preview URL (`https://3000-sb-7f3a.daytona…`), opening the running app in their browser.

**6. Checking state.** `/sandbox status` shows id, base image, uptime, idle timer, and exposed ports.

**7. Wrap up.** User quits Pi. The ephemeral sandbox is torn down automatically — nothing to clean up, no host changes, no lingering cost.

> v1 is deliberately ephemeral and launch-scoped. The richer flows below (mirror local code, mid-session flip, persistence/reattach, interactive shell, auto preview-URLs) are intentionally **deferred** — see [Deferred (post-v1)](#deferred-post-v1).

### The core mental model
> "The agent's brain runs locally; its hands run in a remote container."

Pi, the LLM calls, the TUI, sessions, and settings stay on the host. Only **tool execution** (commands + file I/O) is redirected into the sandbox. The user sees the same Pi UI, plus a persistent status indicator telling them work is happening remotely.

### 1. Activation (v1: launch flag + read-only slash commands)

**A. CLI flag at launch** — the only way to *enter* a sandbox in v1:
```bash
pi --daytona --repo <git-url> [--branch <ref>]   # clone a repo into a fresh sandbox
pi --daytona --blank                              # clean image; agent sets it up
pi --daytona --snapshot <image>                   # optional: choose the base image
```

**B. In-session slash commands** — informational only (they don't change the backend mid-session):
- `/sandbox status` — show id, base image, uptime, idle timer, exposed ports
- `/sandbox url <port>` — print/open the preview URL for a served port

> Activation is launch-scoped on purpose: switching execution backends mid-session is confusing (earlier context assumes host paths). Mid-session control and a settings-based default are deferred.

### 2. Startup flow (what the user sees)

1. User runs `pi --daytona --repo github.com/acme/api`.
2. TUI shows a spinner: `☁  Spinning up Daytona sandbox…`
3. On ready: a transient notice `Sandbox ready · <id> · 1.2s` and a **persistent footer status** (via `ctx.ui.setStatus`, exactly like `ssh.ts`):
   `☁ daytona · <short-id> · running · /home/daytona/api`
4. The agent's system prompt is rewritten so its "current working directory" reflects the **sandbox path**, not the host path (same technique as `ssh.ts`'s `before_agent_start` hook). The agent now reads/writes/runs entirely in the container.

The footer badge is the single source of truth for "you are sandboxed." We intentionally do **not** add a per-tool `☁` marker in v1 (it would mean re-rendering every built-in tool).

### 3. Code source (v1: clone repo or blank)

When a sandbox starts, the agent needs code to work on. Two stateless modes:
- **Clone a git repo** (`--repo <url> [--branch]`) — Daytona clones server-side via `sandbox.git.clone(url, path, branch?, commitId?, username?, password?)`; the primary use case. `--branch` maps to the `branch` arg; private repos can be served by passing a token through `username`/`password` (e.g. a GitHub PAT), though v1 targets public repos first.
- **Blank sandbox** (`--blank`) — the default snapshot (clean image); the agent sets it up.

> The cloned path becomes the agent's working directory. We resolve the base dir from `sandbox.getUserHomeDir()` (the SDK's `getUserRootDir()` is deprecated) — e.g. `/home/daytona` — and clone into `<home>/<repo-name>`, matching the footer/system-prompt path shown below.

> Mirroring the local directory (with sync-back) is deliberately excluded from v1 — bidirectional sync is the highest-risk part of the design (silent overwrites, conflict handling). Cloning/blank are stateless and safe.

### 4. Working with ports / preview URLs

When a server is running inside the sandbox, the user runs `/sandbox url <port>` to get its **preview URL** and open it in a browser. We call `sandbox.getPreviewLink(port)`, which **opens the port automatically if it is closed** and returns `{ url, token }`. The URL follows the format `https://<port>-<sandboxId>.<daytonaProxyDomain>` (e.g. `https://3000-sb-7f3a.proxy.daytona.works`).

> **Auth nuance (verified):** preview links for **private** sandboxes require the `x-daytona-preview-token` header (the `token` from `getPreviewLink`), and that token is invalidated on every sandbox restart. A plain browser open has no way to set that header. So `/sandbox url <port>` will, for private sandboxes, surface both the URL **and** the current token (e.g. as a `curl -H "x-daytona-preview-token: …"` example). To make in-browser preview frictionless we may create the sandbox with `public: true` (preview links then need no token) — a v1 trade-off to confirm in the open decisions. Automatic detection of a started server is deferred — see below.

### 5. Lifecycle & teardown (v1: ephemeral)

- **Ephemeral by default:** the sandbox lives for the session and is **torn down automatically on exit** via `sandbox.delete()` in the `session_shutdown` handler. No prompts, no lingering cost, no host changes. This matches Daytona's "fast, disposable container" value and keeps v1 stateless.
- **Defaults align with us (verified):** Daytona's `create()` defaults are `autoStopInterval: 15` (minutes idle → stop), `autoArchiveInterval: 7 days` (continuously-stopped → archive), and auto-delete **disabled** by default. So even if Pi crashes without a clean shutdown, the sandbox self-stops after 15 idle minutes — a built-in backstop. We additionally pass `ephemeral: true` at create time (which sets `autoDeleteInterval: 0`, deleting the sandbox as soon as it stops) so an abandoned sandbox is reaped, not just stopped.
- The SDK also exposes `setAutostopInterval(min)` / `setAutoDeleteInterval(min)` / `setAutoArchiveInterval(min)` if we ever want to tune these from a running session.

### 6. Status, feedback, and failure UX

- **Footer status** (always visible while sandboxed): `☁ daytona · <id> · <state>`.
- **Connection loss / sandbox error mid-session:** Pi shows a clear banner and **pauses** tool execution. It does **not** silently fall back to running the agent's commands on the host (that would be a safety hazard). The user can retry or quit.
- **Auth:** `DAYTONA_API_KEY` from the environment; if missing, a one-time `ctx.ui.input` prompt for the session. (No secrets vault is available to extensions, so we don't persist to `auth.json`.)

---

## Deferred (post-v1)

Cut from the initial release to keep it small and safe; recorded here so they're not lost. Each is independently addable later.

| Feature | Why deferred |
|---|---|
| **Mirror local dir + sync-back** | Bidirectional sync risks silently overwriting local files; needs conflict handling, ignore rules, large-file strategy. Highest-risk piece. |
| **Persistence & reattach** (`pi --daytona <id>`, resume reconnect) | Persisting/reconnecting to possibly-stopped sandboxes is real complexity; contradicts the ephemeral value prop for v1. Hooks exist (`appendEntry`/`getEntries`, `session_start reason:"resume"`). |
| **Settings `daytona` block + auto-sandbox default** | Auto-sandboxing a whole project is a footgun, and it's unverified whether extensions can read custom settings keys. v1 uses flags + env. |
| **Per-tool `☁` markers** | Requires overriding `renderCall`/`renderResult` for every built-in tool and tracking upstream changes; footer badge already conveys it. |
| **Mid-session `/sandbox start` / `stop` flip** | Switching backend mid-session confuses path/context assumptions. Launch-scoped activation only in v1. |
| **Auto preview-URL detection** | Scraping "listening on port N" from arbitrary bash output is brittle; manual `/sandbox url <port>` is reliable. |
| **`/sandbox shell` (interactive)** | Interactive PTY passthrough (raw mode, resize) is finicky; the agent runs commands itself. |
| **Sandboxed subagents** | Each subagent in its own container for parallel exploration — compelling but a large separate feature on top of Pi's `subagent` extension. |

---

## Packaging & distribution (standalone repository)

We build this as its own repo — e.g. `pi-daytona` — published independently. **No fork of Pi.** Verified mechanics:

**Runtime target.** Pi runs on **Node.js ≥ 22.19.0** (CLI shebang `#!/usr/bin/env node`, `engines.node` in `packages/coding-agent/package.json`). Extensions load as raw TypeScript via **jiti 2.7** — no build step. Pi also ships a **Bun-compiled standalone binary** (`bun build --compile`), whose loader uses `virtualModules` instead of jiti aliases; we target Node as the primary runtime and verify the extension also loads under the Bun binary (native-addon-free deps make this straightforward).

**Repository layout.**
```
pi-daytona/
├── package.json
├── index.ts          # export default function (pi: ExtensionAPI) { … }
├── src/              # ops adapters (bash/read/write/edit/grep/find/ls → Daytona), lifecycle, commands
└── README.md
```

**`package.json` shape.**
```jsonc
{
  "name": "pi-daytona",
  "type": "module",
  "keywords": ["pi-package"],            // surfaces in the pi.dev / npm package gallery
  "pi": { "extensions": ["./index.ts"] }, // entry-point manifest (else falls back to index.ts)
  "dependencies": {
    "@daytona/sdk": "^0.182.0"           // runtime dep; pi install runs `npm install --omit=dev`
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "…" // types only — Pi provides this (and pi-ai/pi-tui/typebox) at runtime
  }
}
```
Key constraint: Pi-owned packages (`@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`, `typebox`) are **provided by the host at runtime**, so they go in `devDependencies` for typing and must not be bundled. Our own runtime deps (the Daytona SDK) belong in `dependencies`.

> **SDK package name (verified):** the correct, current package is **`@daytona/sdk`** — this is what the Daytona docs use throughout. The older **`@daytonaio/sdk`** scope (which this plan's earlier draft referenced) is outdated and should not be used. The package ships dual ESM/CJS and is documented to run under **Node.js and Bun** with no extra config — which satisfies both Pi runtimes (Node ≥ 22.19.0 via jiti, and the Bun-compiled binary), assuming the SDK pulls in no native addons.

**How users install it.**
```bash
pi install npm:pi-daytona@1.0.0              # from npm
pi install git:github.com/jamesmurdza/pi-daytona@v1 # straight from the repo (tag/commit pinned)
pi install ./pi-daytona                       # local path
pi -e ./pi-daytona/index.ts                   # load directly, no install (dev loop)
```
Installed packages land in `~/.pi/agent/npm|git/…` (or `.pi/...` with `-l` for project-local) and are recorded in the `packages` array of `settings.json`.

> Future option (out of scope for this repo): if the feature proves out, the same code could be upstreamed into `packages/coding-agent` to make `--daytona` / `/sandbox` first-class. That would require a fork/PR; the standalone repo does not.

---

## Why this is feasible (architecture hooks — for reference only)

No implementation here, but these confirm the UX above is buildable with existing seams:

| UX element | Existing mechanism |
|---|---|
| Redirect bash/read/write/edit/grep/find/ls to remote | Pluggable `*Operations` interfaces on every tool (`packages/coding-agent/src/core/tools/*.ts`) |
| Tool override per session | `pi.registerTool(...)` delegating to Daytona ops — exact shape of `examples/extensions/ssh.ts` |
| `--daytona`, `--repo`, `--snapshot` flags | `pi.registerFlag(...)` + `pi.getFlag(...)` |
| `/sandbox …` commands | `pi.registerCommand(...)` (`examples/extensions/commands.ts`) |
| Footer status + notices | `ctx.ui.setStatus(...)`, `ctx.ui.notify(...)` |
| Rewrite agent cwd to sandbox path | `before_agent_start` hook (as in `ssh.ts`) |
| Spin up on start / tear down on exit | `session_start` + `session_shutdown` events |
| Read API key | `process.env.DAYTONA_API_KEY` + `ctx.ui.input` fallback (no secrets vault); `new Daytona()` auto-reads it |
| Daytona SDK calls (create, exec, fs, git, preview URLs) | `@daytona/sdk` — see the verified op→SDK mapping below |
| _(deferred)_ Interactive `/sandbox shell` | `user_bash` hook + `interactive-shell.ts` pattern |
| _(deferred)_ Per-tool `☁` marker | `ToolDefinition.renderCall` / `renderResult` (`built-in-tool-renderer.ts`) |
| _(deferred)_ Persist sandbox id + reattach | `pi.appendEntry` + `ctx.sessionManager.getEntries()`; `session_start` `reason:"resume"` (`snake.ts`, `plan-mode/`) |
| _(deferred)_ Auto-surface preview URL | `tool_result` (`isBashToolResult`, `content[].text`) + `tool_execution_update` |

Key reference files to study before building: `examples/extensions/ssh.ts` (the blueprint), `examples/extensions/sandbox/` (config-driven backend swap), `examples/extensions/interactive-shell.ts`, `examples/extensions/with-deps/` (extension with its own deps), and the tool `*Operations` definitions under `packages/coding-agent/src/core/tools/`.

### Verified op → Daytona SDK mapping

The reason the `*Operations` swap is low-risk is that every Pi tool op has a near-1:1 Daytona SDK counterpart. The table below is checked against the current `@daytona/sdk` docs (TypeScript SDK).

| Pi op (interface) | Daytona SDK call | Notes |
|---|---|---|
| `BashOperations` | `sandbox.process.executeCommand(cmd, cwd?, env?, timeout?)` → `{ exitCode, result, artifacts.stdout }` | `result`/`artifacts.stdout` is the combined output. Per-call `cwd` lets us pin commands to the repo dir. |
| long-running bash (dev servers) | `process.createSession(id)` → `executeSessionCommand(id, { command, runAsync: true })` → `getSessionCommandLogs(id, cmdId, onStdout, onStderr)` → `deleteSession(id)` | Needed so a started server keeps running while the agent continues; pairs with the preview-URL flow. |
| `ReadOperations` (read file) | `sandbox.fs.downloadFile(remotePath)` → `Buffer` | Decode to string. `downloadFileStream` exists for large files. |
| `WriteOperations` (write file) | `sandbox.fs.uploadFile(buffer, remotePath)` | Also `uploadFiles([...])` for batch; `createFolder(path, mode)` for dirs. |
| `EditOperations` (edit file) | `sandbox.fs.replaceInFiles([path], pattern, newValue)` — or download→patch→upload for exact-match edits | `replaceInFiles` does batch text replacement; Pi's exact-string edit semantics may favor download+modify+upload to preserve uniqueness checks. |
| `GrepOperations` (search contents) | **custom tool** — run `rg`/`grep` (or `sandbox.fs.findFiles`) **inside** the sandbox | ⚠️ Verified during implementation: Pi's grep tool always spawns ripgrep **locally** and only uses `GrepOperations` (`isDirectory` + `readFile`) for context lines — it does **not** delegate the search. So grep can't be redirected via ops injection; it needs a dedicated tool whose `execute` runs the search in the sandbox. |
| `FindOperations` (find by name) | `sandbox.fs.searchFiles(path, pattern)` | "search **by filename** with glob support." (Note the SDK's naming is the inverse of intuition: `findFiles` = grep, `searchFiles` = find.) |
| `LsOperations` (list dir) | `sandbox.fs.listFiles(path)` → `FileInfo[]`; `getFileDetails(path)` for stat | — |
| clone repo at startup | `sandbox.git.clone(url, path, branch?, commitId?, username?, password?)` | Plus `status`/`pull`/`push`/`commit`/`branches` for future git tooling. |
| create sandbox | `daytona.create({ snapshot?, image?, language?, envVars?, labels?, user?, public?, autoStopInterval?, autoArchiveInterval?, autoDeleteInterval?, ephemeral?, resources? }, { timeout? })` → `sandbox` (`.id`, `.state`) | Default `language: "python"`, default snapshot bundles python+node+LSPs (1 vCPU / 1 GiB / 3 GiB). We pass `ephemeral: true` for v1. |
| resolve working dir | `sandbox.getUserHomeDir()` (→ e.g. `/home/daytona`); `sandbox.getWorkDir()` | `getUserRootDir()` is deprecated. Used for the cwd rewrite + footer path. |
| preview URL | `sandbox.getPreviewLink(port)` → `{ url, token }` | Opens the port if closed; `token` needed for private sandboxes via `x-daytona-preview-token`. |
| teardown / lifecycle | `sandbox.delete(timeout)`; `stop(timeout?, force?)`; `setAutostopInterval(min)` / `setAutoDeleteInterval(min)` / `setAutoArchiveInterval(min)`; `refreshData()` | `delete()` on shutdown; intervals are the crash backstop. |

---

## Verification (how we'll know the UX works)

Since this is a UX proposal, "verification" = walking the v1 journeys end-to-end once built:
1. **Cold start (clone):** `pi --daytona --repo <url>` → sandbox boots, footer shows running status, agent's first `ls`/`bash` clearly runs in the container (verify path = sandbox path, not host).
2. **Blank:** `pi --daytona --blank` → empty sandbox; agent can install tools and create files, all remote.
3. **Preview URL:** agent starts a dev server (via a process session so it keeps running) → `/sandbox url <port>` returns the `getPreviewLink` URL. If the sandbox is `public`, it opens directly in a browser; if private, the command also surfaces the `x-daytona-preview-token`. `/sandbox status` shows accurate state.
4. **Teardown:** quit Pi → sandbox is destroyed (verify via Daytona dashboard/CLI that it's gone; host filesystem untouched).
5. **Failure path:** kill the sandbox mid-session → Pi shows a paused/error banner and does **not** run subsequent commands on the host.
6. **Auth:** unset `DAYTONA_API_KEY` → first use prompts once; set it → no prompt.

---

## Open decisions for you to confirm
- **Packaging:** ✅ Settled — standalone `pi-daytona` repo installed via `pi install`; no fork.
- **Code source:** ✅ Settled for v1 — clone-repo + blank only (mirror deferred).
- **Lifecycle:** ✅ Settled for v1 — ephemeral only (persistence/reattach deferred).
- **Activation:** ✅ Settled for v1 — launch flag + read-only `/sandbox status|url` (mid-session flip + settings default deferred).
1. **Config delivery:** v1 uses CLI flags (`registerFlag`) + `process.env`. A `settings.json` `daytona` block is deferred and depends on whether Pi exposes settings to extensions — needs a quick API check if/when we add it.
2. **Base image:** ✅ Resolved by the docs — Daytona has a **default snapshot** (Python + Node + their language servers + common packages; ~1 vCPU / 1 GiB RAM / 3 GiB disk) that `daytona.create()` uses when no `snapshot`/`image` is given. So `--snapshot` is **optional**: zero-config first-run works out of the box, and `--snapshot <name>` just overrides the base. (One caveat from the issue tracker: overriding `resources` currently requires the image-based create path, not the default snapshot — worth tracking if we expose CPU/memory flags later.)
3. **Preview visibility:** confirm whether v1 creates sandboxes with `public: true` (browser-openable preview URLs, no token) or keeps them private and has `/sandbox url` print the `x-daytona-preview-token`. Public is the smoother demo UX; private is the safer default. (New decision surfaced by the preview-auth docs.)
