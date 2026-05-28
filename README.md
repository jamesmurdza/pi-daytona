# pi-daytona

*[Pi](https://pi.dev) coding agent extension for integration with [Daytona](https://www.daytona.io) sandboxes. The agent runs locally while all tool-calls run inside a sandbox.*

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

### CLI flags

Start from scratch:
```bash
pi --daytona
```

Work on an existing repo:
```bash
pi --daytona --repo github.com/acme/api --branch dev
```

Public preview (browser-openable URLs, no token):
```bash
pi --daytona --repo … --public
```

| Flag | Description |
|---|---|
| `--daytona` | Run tools inside a Daytona sandbox |
| `--repo <url>` | Git repo to clone into the sandbox (server-side) |
| `--branch <name>` | Branch to clone (used with `--repo`) |
| `--snapshot <name>` | Choose a Daytona snapshot / base image |
| `--public` | Create a public sandbox so preview URLs need no token |

### Environment variables

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

| Tool | What it does |
|---|---|
| `bash` (+ user `!`) | Run a command in the sandbox; backgrounded processes (`&`) don't hang the agent |
| `read` | Read a file from the sandbox |
| `write` | Write a file to the sandbox |
| `edit` | Edit a file (download → modify → upload; preserves Pi's exact-match semantics) |
| `ls` | List a sandbox directory |
| `find` | Find files by glob inside the sandbox (gitignore-aware, supports path globs) |
| `grep` | Search file contents inside the sandbox |
| `preview_url(port)` | Get a public preview URL for a port — the agent calls this itself after starting a server (returns the `x-daytona-preview-token` curl hint for private sandboxes) |

## Development

```bash
npm install
npm run check       # typecheck + load smoke (offline)
npm run test:live   # end-to-end against real Daytona (needs DAYTONA_API_KEY)
```

## Roadmap

- **Persist + resume sandbox** — quit pi, come back later, pick up where you left off.
- **`/sandbox shell`** — interactive PTY into the sandbox.
- **`/sandbox sync <path>`** — one-shot local↔sandbox file copy.
- **`/sandbox snapshot <name>`** — capture the current sandbox as a reusable snapshot.
