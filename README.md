# pi-daytona

*Run the [Pi](https://pi.dev) coding agent's tools inside a remote, ephemeral [Daytona](https://www.daytona.io) sandbox — so installs, builds, and destructive commands never touch your laptop.*

## Quick start

1. **Install pi**
   ```bash
   npm install -g @earendil-works/pi-coding-agent
   ```
   See <https://pi.dev> for other install options.

2. **Install the plugin**
   ```bash
   pi install git:github.com/jamesmurdza/pi-daytona
   ```
   > ⚠️ To update later, run `pi update` — `pi install` won't refresh an existing install.

3. **Launch**
   ```bash
   DAYTONA_API_KEY=dtn_... pi --daytona
   ```
   Get a key at <https://app.daytona.io>.

## Usage

### CLI

**Work on an existing repo**
```bash
pi --daytona --repo github.com/acme/api --branch dev
```

**Start from scratch**
```bash
pi --daytona --blank
```

**Public preview (browser-openable URLs, no token)**
```bash
pi --daytona --repo … --public
```

#### All flags

| Flag | Description |
|---|---|
| `--daytona` | Run tools inside a Daytona sandbox |
| `--repo <url>` | Git repo to clone into the sandbox (server-side) |
| `--branch <name>` | Branch to clone (used with `--repo`) |
| `--blank` | Start with a blank sandbox (no repo) |
| `--snapshot <name>` | Choose a Daytona snapshot / base image |
| `--public` | Create a public sandbox so preview URLs need no token |

Environment:
- `DAYTONA_API_KEY` *(required)* — or you'll be prompted once per session.
- `DAYTONA_API_URL` — defaults to `https://app.daytona.io/api`.
- `DAYTONA_TARGET` — e.g. `us`.

### Interactive sessions

Once pi is running with `--daytona`, the cloud badge in the footer is the always-visible signal that work is remote:

```
☁ daytona · 7f3a9b21 · running · /home/daytona
```

Slash commands you can type:

- `/sandbox status` — id, state, working dir, snapshot, visibility
- `/sandbox url <port>` — manual fallback for getting a preview URL

## How it works

The agent's brain (LLM, TUI, sessions) stays on your machine. Pi's tool layer is pluggable, so `pi-daytona` substitutes Daytona-backed implementations of `bash` / `read` / `write` / `edit` / `ls`, plus dedicated in-sandbox tools for `find` / `grep`. A footer badge is the always-visible signal that work is remote.

### Backgrounding

Daytona's `executeCommand` resolves only when the command's output reaches EOF, so a backgrounded process (`server &`) would normally hold the pipe open and hang the agent. We wrap every bash command in a subshell whose combined output is redirected to a temp file, so backgrounded processes detach cleanly and the call returns as soon as the **foreground** finishes.

> 💡 A command left in the **foreground** (no `&`) that never exits will still block the turn, exactly like in a normal shell — background it or pass a `timeout`.

### Tools the agent calls

Beyond the standard `bash` / `read` / `write` / `edit` / `ls` / `find` / `grep` overrides, pi-daytona registers extra LLM-callable tools:

- `preview_url(port)` — the primary way to get a preview link. The agent calls this itself after starting a server, then hands you a clickable URL. Returns the URL plus, on private sandboxes, the `x-daytona-preview-token` curl hint.

### Lifecycle

- **Idle pauses** the sandbox (`autoStopInterval: 30` min). Its filesystem is preserved; the next tool call transparently restarts it.
- **Deleted on quit** (`sandbox.delete()`).
- **Crash backstop**: `autoDeleteInterval: 1440` (delete ~24h after stopping) and Daytona's 7-day auto-archive.
- If the sandbox is ever genuinely gone, tool calls fail with a clear message telling you to restart — they are **never** silently run on your host.

### Tool → Daytona mapping

| Pi tool | Backed by |
|---|---|
| `bash` (+ user `!`) | `sandbox.process.executeCommand` (wrapped for background safety) |
| `read` | `sandbox.fs.downloadFile` |
| `write` | `sandbox.fs.uploadFile` |
| `edit` | download → apply edits → upload (preserves Pi's exact-match semantics) |
| `ls` | `sandbox.fs` via shell (`test`, `ls -1A`) |
| `find` | `rg --files -g <glob>` (POSIX `find` fallback) run **inside** the sandbox — Daytona's `searchFiles` only does basename matching |
| `grep` | `rg` / `grep` run **inside** the sandbox — Pi's grep runs `rg` locally and uses ops only for context lines |

## Development

```bash
npm install
npm run check       # typecheck + jiti load smoke (no key/network)
npm run test:live   # full end-to-end against real Daytona (needs DAYTONA_API_KEY)
```

`npm run check` loads the extension via Pi's own jiti loader against a stub API and asserts it registers all flags, tools, events, and commands — no Daytona key or network required.

`npm run test:live` drives the real extension against real Daytona:

- **connectivity** — create / exec / delete a sandbox.
- **integration** — the full v1 journey: create + clone, every tool, system-prompt cwd rewrite, `/sandbox status` + `url`, `preview_url` tool, live preview-URL reachability, and verified teardown.
- **variants** — `--blank`, `--public` (tokenless preview), mid-session sandbox death (tools must error, never silently run on the host), and the missing-key path.
- **bash-bg** — backgrounded processes return immediately and keep serving.
- **recovery** — an idle/stopped sandbox auto-restarts on the next tool call; a deleted one yields a clear error.

`npm run test:e2e` / `npm run test:e2e-preview` are true end-to-end runs through the **real `pi` CLI** with a scripted fake provider — they drive real `bash` / `preview_url` tool calls through Pi's actual agent loop.

## Roadmap

Concrete next features, grouped by theme.

### Agent UX

- **`serve(command, port)` tool** — background a command and return its preview URL in one call (combines bash + `preview_url`).
- **Auto preview-URL detection** — sniff bash output for *"listening on port N"* and surface URLs without an explicit tool call.
- **Per-tool `☁` marker** — render a cloud icon on tool calls when they run in the sandbox.
- **Disconnection status** — when a sandbox dies mid-session, update the footer to `☁ unavailable` instead of just throwing on the next call.

### Session continuity

- **Persist + resume sandbox id** — quit pi, come back later, keep your sandbox (filesystem, work, everything). Pairs naturally with the idle-pause lifecycle we already have.
- **`pi --daytona <id>`** — attach to an existing sandbox at launch.
- **Mid-session flip** — `/sandbox start | stop` to enable/disable the sandbox from a live session.

### More tools and commands

- **`/sandbox shell`** — interactive PTY into the sandbox (using `sandbox.pty`).
- **`/sandbox sync <path>`** — explicit, one-shot local↔sandbox file copy (the deferred-because-risky bidirectional sync, but opt-in so it's safe).
- **`/sandbox snapshot <name>`** — capture the current sandbox as a reusable snapshot so the next launch (or a teammate's) gets the same prebuilt env.
- **`/sandbox logs`** — tail recent process output, especially useful paired with process sessions.
- **`sandbox_info()` tool** — id, state, resources, uptime, cwd for the agent to reason about.
- **`git_commit(message)` / `git_push()` tools** — let the agent persist its work via `sandbox.git`.

### Process management

- **Process-sessions registry** — adopt Daytona's `sandbox.process.createSession` for properly-tracked long-running processes (dev servers, watchers), with start / stop / logs by name. A more principled answer to backgrounding than the `&` wrapper.

### Configuration

- **`daytona` settings block** in `~/.pi/agent/settings.json` for defaults (`--daytona`, `--public`, `--snapshot`, resources).
- **Resource flags** — `--cpu`, `--memory`, `--disk`, `--gpu` (image-based create).
- **Network policy flags** — `--network-block-all`, `--network-allow=<cidr>`.
- **First-run wizard** — if `DAYTONA_API_KEY` is missing, walk the user through getting one.

### Bigger swings

- **Sandboxed sub-agents** — each subagent gets its own sandbox for parallel exploration without stepping on the main session's filesystem.
