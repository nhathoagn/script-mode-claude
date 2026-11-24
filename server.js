"use strict";
/*
 * claude-script-mode: MCP stdio server exposing programmatic tool calling.
 *
 * `script` runs a JS program inside `node --permission` (fs limited to the
 * runner + code file); helpers read/write/edit/grep/glob/bash/text/sleep are
 * bridged over JSON-RPC on the child's stdio and dispatched here under policy.
 * Only text() output is returned to the model context.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");
const { deniedBashCommand, loadPolicy, resolveInside } = require("./policy");

const RUNNER = path.join(__dirname, "runner.cjs");
const CWD = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const PROTOCOL_VERSION = "2024-11-05";
const OPS = new Set(["read", "write", "edit", "grep", "glob", "bash", "text", "log", "sleep"]);

const logDir = () => path.join(CWD, ".claude", "script-logs");

const DESCRIPTION = `Run one async JS program that batches file/shell work inside a Node sandbox; only text() output reaches your context.

USE ONLY for >=4 same-shape calls or >10KB of tool output - otherwise call the built-in tools directly, it is cheaper.

Async helpers: read(path), write(path,content), edit(path,from,to,{all}), grep(pattern,{root,glob}), glob(pattern,{root}), bash(command,{timeoutMs}), text(s), sleep(ms). Prefer Promise.all for independent calls.

Keep raw results in variables; text() only the distilled answer (<=16KB). No require/process/fs. Paths confined to project root; bash() has a policy denylist; .claude/script-mode.json extends policy.`;

// ---------------------------------------------------------------- sandbox --

async function runScript(code, deps = {}) {
	const policy = deps.policy || loadPolicy(CWD);
	const dir = deps.logDir || logDir();
	fs.mkdirSync(dir, { recursive: true });
	const started = Date.now();

	const runId = `run-${started.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const logPath = path.join(dir, `${runId}.log`);
	const codePath = path.join(dir, `${runId}.code.js`);
	fs.writeFileSync(codePath, code, "utf8");
	const log = fs.createWriteStream(logPath, { flags: "a" });
	const logLine = s => log.write(`[${new Date().toISOString()}] ${s}\n`);

	const child = spawn(
		"node",
		["--permission", `--allow-fs-read=${RUNNER}`, `--allow-fs-read=${codePath}`, RUNNER, codePath],
		{
			cwd: policy.root,
			env: { NODE_DISABLE_COMPILE_CACHE: "1", PATH: process.env.PATH ?? "/usr/bin:/bin" },
			stdio: ["pipe", "pipe", "pipe"],
		},
	);

	let callCount = 0;
	let bytesIn = 0;
	let textBuf = "";
	let textTruncated = false;
	let finished;
	let finishedValue;
	let childExited = false;

	const rl = readline.createInterface({ input: child.stdout });

	const respond = (id, res, error) => {
		const frame = JSON.stringify(error ? { id, error } : { id, result: res });
		if (!error && res !== undefined) bytesIn += frame.length;
		if (childExited || !child.stdin?.writable) return;
		child.stdin.write(`${frame}\n`);
	};

	const cap = s =>
		s.length > policy.maxResultBytes
			? `${s.slice(0, policy.maxResultBytes)}\n[result truncated at ${policy.maxResultBytes} bytes]`
			: s;

	const requireWritable = () => {
		if (!policy.writable) throw new Error("writes disabled by policy (writable: false)");
	};

	const sh = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

	const runBash = (cmd, timeoutMs) =>
		new Promise((resolve, reject) => {
			const proc = spawn("bash", ["-lc", cmd], { cwd: policy.root, env: process.env });
			const out = [];
			const err = [];
			proc.stdout?.on("data", d => out.push(String(d)));
			proc.stderr?.on("data", d => err.push(String(d)));
			const t = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
			proc.on("exit", code => {
				clearTimeout(t);
				const body = out.join("") + (err.length ? `\n[stderr]\n${err.join("")}` : "");
				resolve(code === 0 ? body : `${body}\n[exit ${code}]`);
			});
			proc.on("error", reject);
		});

	const dispatch = async (op, args) => {
		switch (op) {
			case "read":
				return cap(await fsp.readFile(resolveInside(args.path, policy), "utf8"));
			case "write": {
				requireWritable();
				const abs = resolveInside(args.path, policy);
				await fsp.mkdir(path.dirname(abs), { recursive: true });
				await fsp.writeFile(abs, String(args.content), "utf8");
				return { path: abs, bytes: Buffer.byteLength(String(args.content)) };
			}
			case "edit": {
				requireWritable();
				const abs = resolveInside(args.path, policy);
				const src = await fsp.readFile(abs, "utf8");
				const from = String(args.from);
				const to = String(args.to ?? "");
				const count = src.split(from).length - 1;
				if (count === 0) throw new Error(`edit: string not found in ${args.path}`);
				if (count > 1 && args.all !== true)
					throw new Error(`edit: string occurs ${count}x in ${args.path}; pass all:true or disambiguate`);
				await fsp.writeFile(abs, args.all === true ? src.split(from).join(to) : src.replace(from, to), "utf8");
				return { path: abs, replaced: args.all === true ? count : 1 };
			}
			case "grep": {
				const root = resolveInside(args.root ?? ".", policy);
				const glob = args.glob ? `--glob ${sh(args.glob)} ` : "";
				return cap(await runBash(`rg --line-number --no-heading ${glob}-- ${sh(args.pattern)} ${sh(root)} || true`, 60_000));
			}
			case "glob": {
				const root = resolveInside(args.root ?? ".", policy);
				const matches = [];
				let truncated = false;
				for await (const m of fsp.glob(String(args.pattern), { cwd: root })) {
					if (matches.length >= 2000) { truncated = true; break; }
					matches.push(m);
				}
				return { matches, truncated };
			}
			case "bash": {
				if (!policy.allowBash) throw new Error("bash() disabled by policy");
				const cmd = String(args.command);
				const deny = deniedBashCommand(cmd, policy);
				if (deny) throw new Error(`bash() denied by policy pattern: ${deny}`);
				return cap(await runBash(cmd, Number(args.timeoutMs) || policy.bashTimeoutMs));
			}
			case "text": {
				const s = String(args.s ?? "");
				logLine(`text> ${s}`);
				if (textBuf.length < policy.maxTextBytes) {
					textBuf += (textBuf ? "\n" : "") + s;
					if (textBuf.length > policy.maxTextBytes) {
						textBuf = textBuf.slice(0, policy.maxTextBytes);
						textTruncated = true;
					}
				} else textTruncated = true;
				return undefined;
			}
			case "log":
				logLine(`log> ${String(args.s ?? "")}`);
				return undefined;
			case "sleep":
				await new Promise(r => setTimeout(r, Math.min(Number(args.ms) || 0, 30_000)));
				return undefined;
			default:
				throw new Error(`unknown op: ${op}`);
		}
	};

	rl.on("line", line => {
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			logLine(`bad-frame> ${line.slice(0, 500)}`);
			return;
		}
		if (msg.t === "finish") {
			finished = { ok: msg.ok === true, error: typeof msg.error === "string" ? msg.error : undefined };
			finishedValue = msg.value;
			return;
		}
		if (typeof msg.id !== "number" || typeof msg.op !== "string" || !OPS.has(msg.op)) {
			logLine(`bad-req> ${line.slice(0, 500)}`);
			return;
		}
		callCount++;
		logLine(`call ${msg.id} ${msg.op} ${JSON.stringify(msg.args).slice(0, 800)}`);
		dispatch(msg.op, msg.args ?? {})
			.then(res => respond(msg.id, res))
			.catch(err => respond(msg.id, undefined, err instanceof Error ? err.message : String(err)));
	});

	const stderr = [];
	child.stderr?.on("data", d => stderr.push(String(d)));

	const kill = () => {
		if (!childExited) {
			try { child.kill("SIGKILL"); } catch { /* gone */ }
		}
	};

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		kill();
	}, policy.maxScriptMs);
	timer.unref?.();

	const onAbort = () => kill();
	deps.signal?.addEventListener("abort", onAbort, { once: true });

	const { promise: exitPromise, resolve: onExit } = Promise.withResolvers();
	child.on("exit", () => { childExited = true; onExit(); });
	child.on("error", () => { childExited = true; onExit(); });
	await exitPromise;

	clearTimeout(timer);
	deps.signal?.removeEventListener("abort", onAbort);
	logLine(`--- end calls=${callCount} timedOut=${timedOut}`);
	log.end();

	const errText = stderr.join("").trim();
	let error;
	if (finished && !finished.ok) error = finished.error ?? "script failed";
	if (!finished && !timedOut) error = errText || "script exited without finishing";
	if (timedOut) error = `script exceeded ${policy.maxScriptMs}ms limit`;
	if (deps.signal?.aborted) error = "aborted";

	if (textTruncated) textBuf += "\n[output truncated: full results in log file]";

	return {
		ok: error === undefined,
		text: textBuf,
		value: finishedValue,
		bytesIn,
		callCount,
		durationMs: Date.now() - started,
		logPath,
		error,
		timedOut,
	};
}

// ------------------------------------------------------------- jobs (bg) --

const jobs = new Map();
let seq = 0;

function startJob(code, label) {
	const id = `job-${++seq}`;
	const job = { id, label, started: Date.now(), state: "running", controller: new AbortController(), result: undefined };
	jobs.set(id, job);
	runScript(code, { signal: job.controller.signal })
		.then(r => {
			job.state = job.state === "cancelled" ? "cancelled" : r.ok ? "done" : "failed";
			job.result = r;
		})
		.catch(e => {
			job.state = "failed";
			job.result = {
				ok: false, text: "", bytesIn: 0, callCount: 0,
				durationMs: Date.now() - job.started, logPath: "",
				error: e instanceof Error ? e.message : String(e),
			};
		});
	return job;
}

// ----------------------------------------------------------------- tools --

const TOOLS = [
	{
		name: "script",
		description: DESCRIPTION,
		inputSchema: {
			type: "object",
			properties: {
				code: { type: "string", description: "JavaScript program; async helpers in scope; top-level await allowed" },
				background: { type: "boolean", description: "true: run detached, return a job id; poll with script_status" },
				label: { type: "string", description: "short job label for status reporting" },
			},
			required: ["code"],
		},
	},
	{
		name: "script_status",
		description: "Check a background script job's state and tail its log.",
		inputSchema: {
			type: "object",
			properties: {
				jobId: { type: "string" },
				tail: { type: "number", description: "last N bytes of the run log to include" },
			},
			required: ["jobId"],
		},
	},
	{
		name: "script_cancel",
		description: "Kill a running background script job.",
		inputSchema: {
			type: "object",
			properties: { jobId: { type: "string" } },
			required: ["jobId"],
		},
	},
];

const ok = text => ({ content: [{ type: "text", text }] });
const err = text => ({ content: [{ type: "text", text }], isError: true });

function formatRun(r) {
	if (!r.ok) return err(`script failed: ${r.error}\n${r.text}`.trim());
	let text = r.text || "(script finished; nothing printed — see log file)";
	if (r.callCount <= 3 && r.bytesIn < 8192) {
		text += `\n[script note: ${r.callCount} bridged call(s), ${r.bytesIn}B kept in sandbox — direct tool calls would have cost fewer tokens here]`;
	}
	return ok(text);
}

async function callTool(name, args) {
	if (name === "script") {
		if (!args || typeof args.code !== "string") return err("missing required param: code");
		if (args.background) {
			const job = startJob(args.code, args.label);
			return ok(`background job ${job.id} started${args.label ? ` (${args.label})` : ""}. Poll with script_status; cancel with script_cancel.`);
		}
		return formatRun(await runScript(args.code));
	}
	if (name === "script_status") {
		const job = jobs.get(String(args?.jobId));
		if (!job) return err(`unknown job: ${args?.jobId}`);
		let tail = "";
		const n = Number(args?.tail) || 0;
		if (n > 0 && job.result?.logPath && fs.existsSync(job.result.logPath)) {
			const buf = fs.readFileSync(job.result.logPath);
			tail = `\n--- log tail ---\n${buf.slice(-n).toString("utf8")}`;
		}
		const r = job.result;
		return ok(
			`job ${job.id}: ${job.state} (${((Date.now() - job.started) / 1000).toFixed(1)}s)` +
				(r ? `\ncalls=${r.callCount} bytesIn=${r.bytesIn} log=${r.logPath}\nresult: ${r.ok ? r.text.slice(0, 4000) : r.error}` : "") +
				tail,
		);
	}
	if (name === "script_cancel") {
		const job = jobs.get(String(args?.jobId));
		if (!job) return err(`unknown job: ${args?.jobId}`);
		if (job.state !== "running") return ok(`job ${job.id} already ${job.state}`);
		job.state = "cancelled";
		job.controller.abort();
		return ok(`job ${job.id} cancelled`);
	}
	return err(`unknown tool: ${name}`);
}

// ------------------------------------------------------------------- MCP --

const rl = readline.createInterface({ input: process.stdin });
const send = obj => process.stdout.write(`${JSON.stringify(obj)}\n`);

rl.on("line", line => {
	let msg;
	try {
		msg = JSON.parse(line);
	} catch {
		return;
	}
	if (msg.method === "notifications/initialized" || msg.method === "notifications/cancelled") return;
	const { id, method, params } = msg;
	const reply = (result, error) => {
		if (id === undefined) return;
		send(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result });
	};

	if (method === "initialize") {
		reply({
			protocolVersion: PROTOCOL_VERSION,
			capabilities: { tools: {} },
			serverInfo: { name: "claude-script-mode", version: "0.1.0" },
		});
		return;
	}
	if (method === "ping") return reply({});
	if (method === "tools/list") return reply({ tools: TOOLS });
	if (method === "tools/call") {
		callTool(params?.name, params?.arguments ?? {}).then(
			r => reply(r),
			e => reply(undefined, { code: -32603, message: String(e) }),
		);
		return;
	}
	if (id !== undefined) reply(undefined, { code: -32601, message: `method not found: ${method}` });
});
