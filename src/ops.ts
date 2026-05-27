/**
 * Daytona-backed implementations of Pi's pluggable tool operations.
 *
 * Each Pi tool (`bash`, `read`, `write`, `edit`, `ls`, `find`) accepts an
 * `*Operations` object. We provide versions that run against a remote Daytona
 * sandbox instead of the local machine. The tool factories are given the
 * sandbox working directory as their `cwd`, so the absolute paths Pi resolves
 * and hands to these ops are already sandbox-rooted.
 *
 * Note on `grep`: Pi's grep tool always spawns ripgrep locally and only uses
 * its operations to read context lines — it does NOT delegate the search. So a
 * remote grep cannot be done via ops injection; it needs a dedicated tool that
 * runs the search inside the sandbox. That lives in `grep-tool.ts`, not here.
 */

import type { Sandbox } from "@daytona/sdk";
import type {
	BashOperations,
	EditOperations,
	FindOperations,
	LsOperations,
	ReadOperations,
	WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { shellQuote } from "./util.ts";

const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** Run a command in the sandbox and return its combined stdout and exit code. */
async function run(sandbox: Sandbox, command: string): Promise<{ stdout: string; exitCode: number }> {
	const res = await sandbox.process.executeCommand(command);
	const stdout = res.result ?? res.artifacts?.stdout ?? "";
	return { stdout, exitCode: res.exitCode ?? 0 };
}

export function createBashOps(sandbox: Sandbox): BashOperations {
	return {
		// Daytona's executeCommand is non-streaming, so we emit the whole output
		// once when it resolves. Long-running processes (e.g. dev servers) are a
		// separate concern handled via process sessions, not the bash tool.
		exec: async (command, cwd, { onData, signal, timeout }) => {
			if (signal?.aborted) throw new Error("aborted");
			// We deliberately do not forward the host `env` into the sandbox: the
			// container has its own environment, and leaking host vars is unsafe.
			const res = await sandbox.process.executeCommand(command, cwd, undefined, timeout);
			const output = res.result ?? res.artifacts?.stdout ?? "";
			if (output) onData(Buffer.from(output));
			return { exitCode: res.exitCode ?? null };
		},
	};
}

export function createReadOps(sandbox: Sandbox): ReadOperations {
	return {
		readFile: (path) => sandbox.fs.downloadFile(path),
		access: async (path) => {
			const { exitCode } = await run(sandbox, `test -r ${shellQuote(path)}`);
			if (exitCode !== 0) throw new Error(`File not readable: ${path}`);
		},
		detectImageMimeType: async (path) => {
			try {
				const { stdout } = await run(sandbox, `file --mime-type -b ${shellQuote(path)}`);
				const mime = stdout.trim();
				return IMAGE_MIME_TYPES.has(mime) ? mime : null;
			} catch {
				return null;
			}
		},
	};
}

export function createWriteOps(sandbox: Sandbox): WriteOperations {
	return {
		writeFile: (path, content) => sandbox.fs.uploadFile(Buffer.from(content, "utf8"), path),
		// `mkdir -p` is idempotent; fs.createFolder errors if the folder exists.
		mkdir: async (dir) => {
			await run(sandbox, `mkdir -p ${shellQuote(dir)}`);
		},
	};
}

export function createEditOps(sandbox: Sandbox): EditOperations {
	// Pi's edit tool reads the file, applies exact oldText->newText edits
	// in-process, then writes it back — preserving its uniqueness checks.
	// This is the download -> modify -> upload strategy.
	return {
		readFile: (path) => sandbox.fs.downloadFile(path),
		writeFile: (path, content) => sandbox.fs.uploadFile(Buffer.from(content, "utf8"), path),
		access: async (path) => {
			const { exitCode } = await run(sandbox, `test -r ${shellQuote(path)} && test -w ${shellQuote(path)}`);
			if (exitCode !== 0) throw new Error(`File not readable/writable: ${path}`);
		},
	};
}

export function createLsOps(sandbox: Sandbox): LsOperations {
	return {
		exists: async (path) => {
			const { exitCode } = await run(sandbox, `test -e ${shellQuote(path)}`);
			return exitCode === 0;
		},
		stat: async (path) => {
			const { stdout, exitCode } = await run(sandbox, `test -d ${shellQuote(path)} && echo dir || echo other`);
			if (exitCode !== 0) throw new Error(`Path not found: ${path}`);
			const isDir = stdout.trim() === "dir";
			return { isDirectory: () => isDir };
		},
		readdir: async (path) => {
			const { stdout } = await run(sandbox, `ls -1A ${shellQuote(path)}`);
			return stdout.split("\n").filter((line) => line.length > 0);
		},
	};
}

export function createFindOps(sandbox: Sandbox): FindOperations {
	return {
		exists: async (path) => {
			const { exitCode } = await run(sandbox, `test -e ${shellQuote(path)}`);
			return exitCode === 0;
		},
		// Delegate globbing to the sandbox. Daytona exposes fs.searchFiles for
		// filename matching; results are returned relative to the search dir.
		glob: async (pattern, cwd, options) => {
			const result = await sandbox.fs.searchFiles(cwd, pattern);
			const files = result.files ?? [];
			return files.slice(0, options.limit);
		},
	};
}
