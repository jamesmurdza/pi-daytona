/**
 * pi-daytona — run Pi's tools inside a remote, ephemeral Daytona sandbox.
 *
 * The agent's brain (LLM, TUI, sessions) stays local; only tool execution
 * (bash + file I/O) is redirected into a Daytona container. Activation is
 * launch-scoped via the `--daytona` flag; the sandbox is torn down on exit.
 *
 * Blueprint: examples/extensions/ssh.ts from @earendil-works/pi-coding-agent.
 */

import { Daytona, type Sandbox } from "@daytona/sdk";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { resolveApiKey } from "./src/auth.ts";
import {
	createBashOps,
	createEditOps,
	createFindOps,
	createLsOps,
	createReadOps,
	createWriteOps,
} from "./src/ops.ts";
import { joinPath, normalizeRepoUrl, repoName, shortId } from "./src/util.ts";

/** State for the sandbox bound to the current session. */
interface ActiveSandbox {
	sandbox: Sandbox;
	/** Working directory inside the sandbox (repo root, or home for blank). */
	cwd: string;
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("daytona", { description: "Run tools inside a Daytona sandbox", type: "boolean" });
	pi.registerFlag("repo", { description: "Git repo to clone into the sandbox", type: "string" });
	pi.registerFlag("branch", { description: "Branch to clone (with --repo)", type: "string" });
	pi.registerFlag("blank", { description: "Start a blank sandbox (no repo)", type: "boolean" });
	pi.registerFlag("snapshot", { description: "Daytona snapshot/base image to use", type: "string" });
	pi.registerFlag("public", { description: "Create a public sandbox (preview URLs need no token)", type: "boolean" });

	const localCwd = process.cwd();
	const localBash = createBashTool(localCwd);
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localLs = createLsTool(localCwd);
	const localFind = createFindTool(localCwd);

	// Resolved lazily on session_start (CLI flags are not available at load time).
	let active: ActiveSandbox | null = null;

	// --- Tool registration: delegate to the sandbox when one is active. ---

	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate) {
			if (active) {
				const tool = createBashTool(active.cwd, { operations: createBashOps(active.sandbox) });
				return tool.execute(id, params, signal, onUpdate);
			}
			return localBash.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate) {
			if (active) {
				const tool = createReadTool(active.cwd, { operations: createReadOps(active.sandbox) });
				return tool.execute(id, params, signal, onUpdate);
			}
			return localRead.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate) {
			if (active) {
				const tool = createWriteTool(active.cwd, { operations: createWriteOps(active.sandbox) });
				return tool.execute(id, params, signal, onUpdate);
			}
			return localWrite.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate) {
			if (active) {
				const tool = createEditTool(active.cwd, { operations: createEditOps(active.sandbox) });
				return tool.execute(id, params, signal, onUpdate);
			}
			return localEdit.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localLs,
		async execute(id, params, signal, onUpdate) {
			if (active) {
				const tool = createLsTool(active.cwd, { operations: createLsOps(active.sandbox) });
				return tool.execute(id, params, signal, onUpdate);
			}
			return localLs.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localFind,
		async execute(id, params, signal, onUpdate) {
			if (active) {
				const tool = createFindTool(active.cwd, { operations: createFindOps(active.sandbox) });
				return tool.execute(id, params, signal, onUpdate);
			}
			return localFind.execute(id, params, signal, onUpdate);
		},
	});

	// Route user `!` bash commands to the sandbox too.
	pi.on("user_bash", () => {
		if (!active) return;
		return { operations: createBashOps(active.sandbox) };
	});

	// --- Lifecycle ---

	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("daytona") !== true) return;
		if (active) return; // already running (e.g. after reload)

		const apiKey = await resolveApiKey(ctx);
		if (!apiKey) {
			ctx.ui.notify("Daytona: no API key found — staying local. Set DAYTONA_API_KEY.", "error");
			return;
		}

		setStatus(ctx, "☁ daytona · spinning up sandbox…");
		const startedAt = Date.now();

		try {
			const daytona = new Daytona({ apiKey });
			const snapshot = stringFlag(pi.getFlag("snapshot"));
			const isPublic = pi.getFlag("public") === true;

			const sandbox = await daytona.create({
				snapshot,
				public: isPublic,
				ephemeral: true, // autoDeleteInterval = 0: reaped as soon as it stops
				labels: { "created-by": "pi-daytona" },
			});

			const home = (await sandbox.getUserHomeDir()) ?? "/home/daytona";
			let cwd = home;

			const repo = stringFlag(pi.getFlag("repo"));
			const blank = pi.getFlag("blank") === true;
			if (repo && !blank) {
				const url = normalizeRepoUrl(repo);
				cwd = joinPath(home, repoName(repo));
				const branch = stringFlag(pi.getFlag("branch"));
				await sandbox.git.clone(url, cwd, branch);
			}

			active = { sandbox, cwd };

			const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
			ctx.ui.notify(`Sandbox ready · ${shortId(sandbox.id)} · ${secs}s`, "info");
			setRunningStatus(ctx, sandbox.id, cwd);
		} catch (err) {
			active = null;
			setStatus(ctx, undefined);
			ctx.ui.notify(`Daytona: failed to start sandbox — ${errorMessage(err)}`, "error");
		}
	});

	// Rewrite the agent's "current working directory" to the sandbox path.
	pi.on("before_agent_start", (event) => {
		if (!active) return;
		const systemPrompt = event.systemPrompt.replace(
			`Current working directory: ${localCwd}`,
			`Current working directory: ${active.cwd} (inside Daytona sandbox ${shortId(active.sandbox.id)})`,
		);
		return { systemPrompt };
	});

	// Tear down the ephemeral sandbox on exit.
	pi.on("session_shutdown", async (event, ctx) => {
		if (!active) return;
		if (event.reason !== "quit" && event.reason !== "reload") return;
		const { sandbox } = active;
		active = null;
		setStatus(ctx, undefined);
		try {
			await sandbox.delete();
		} catch {
			// Best-effort: ephemeral + autoStop guarantees the sandbox is reaped anyway.
		}
	});
}

// --- helpers ---

function setStatus(ctx: ExtensionContext, text: string | undefined): void {
	ctx.ui.setStatus("daytona", text === undefined ? undefined : ctx.ui.theme.fg("accent", text));
}

function setRunningStatus(ctx: ExtensionContext, id: string, cwd: string): void {
	setStatus(ctx, `☁ daytona · ${shortId(id)} · running · ${cwd}`);
}

function stringFlag(value: boolean | string | undefined): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
