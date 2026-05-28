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
pi --daytona
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

### Lifecycle

- **Idle pauses** the sandbox (`autoStopInterval: 30` min). Its filesystem is preserved; the next tool call transparently restarts it.
- **Deleted on quit** (`sandbox.delete()`).
- **Crash backstop**: `autoDeleteInterval: 1440` (delete ~24h after stopping) and Daytona's 7-day auto-archive.
- If the sandbox is ever genuinely gone, tool calls fail with a clear message telling you to restart — they are **never** silently run on your host.

### Tools

The standard Pi tools are backed by Daytona under the hood:

| Pi tool | Backed by |
|---|---|
| `bash` (+ user `!`) | `sandbox.process.executeCommand` (wrapped for background safety) |
| `read` | `sandbox.fs.downloadFile` |
| `write` | `sandbox.fs.uploadFile` |
| `edit` | download → apply edits → upload (preserves Pi's exact-match semantics) |
| `ls` | `sandbox.fs` via shell (`test`, `ls -1A`) |
| `find` | `rg --files -g <glob>` (POSIX `find` fallback) run **inside** the sandbox — Daytona's `searchFiles` only does basename matching |
| `grep` | `rg` / `grep` run **inside** the sandbox — Pi's grep runs `rg` locally and uses ops only for context lines |

Plus an extra LLM-callable tool:

- `preview_url(port)` — the primary way to get a preview link. The agent calls this itself after starting a server, then hands you a clickable URL. Returns the URL plus, on private sandboxes, the `x-daytona-preview-token` curl hint.

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
- **variants** — `--public` (tokenless preview), mid-session sandbox death (tools must error, never silently run on the host), and the missing-key path.
- **bash-bg** — backgrounded processes return immediately and keep serving.
- **recovery** — an idle/stopped sandbox auto-restarts on the next tool call; a deleted one yields a clear error.

`npm run test:e2e` / `npm run test:e2e-preview` are true end-to-end runs through the **real `pi` CLI** with a scripted fake provider — they drive real `bash` / `preview_url` tool calls through Pi's actual agent loop.

## Roadmap

- **`serve(command, port)` tool** — background a command and return its preview URL in one call.
- **Auto preview-URL detection** — surface URLs from bash output without an explicit tool call.
- **Persist + resume sandbox** — quit pi, come back later, pick up where you left off.
- **`/sandbox shell`** — interactive PTY into the sandbox.
- **`/sandbox sync <path>`** — one-shot local↔sandbox file copy.
- **`/sandbox snapshot <name>`** — capture the current sandbox as a reusable snapshot.
- **Process-sessions registry** — named long-running processes with start / stop / logs.
- **Sandboxed sub-agents** — each subagent in its own sandbox for parallel exploration.
