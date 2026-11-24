"use strict";
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_BASH_DENY = [
	`\\brm\\s+(-[a-zA-Z]*[rf][a-zA-Z]*\\s+)*[^|;&]*`,
	`\\bsudo\\b`,
	`\\bgit\\s+push\\b[^|;&]*--force`,
	`\\bgit\\s+push\\s+-f\\b`,
	`\\bmkfs\\b`,
	`\\bdd\\s+.*of=/dev/`,
	`\\bshutdown\\b|\\breboot\\b|\\bhalt\\b`,
	`\\b:\\(\\)\\s*{`,
	`\\bcurl\\b[^|]*\\|\\s*(ba)?sh\\b`,
	`\\bwget\\b[^|]*\\|\\s*(ba)?sh\\b`,
	`>\\s*/etc/`,
	`\\bchmod\\s+777\\s+/`,
	`\\bnpm\\s+publish\\b|\\bbun\\s+publish\\b`,
];

function defaultPolicy(cwd) {
	return {
		root: cwd,
		allowPaths: [],
		writable: true,
		allowBash: true,
		bashDeny: DEFAULT_BASH_DENY,
		maxResultBytes: 256 * 1024,
		maxTextBytes: 16 * 1024,
		bashTimeoutMs: 150_000,
		maxScriptMs: 480_000,
	};
}

const POLICY_FILE = "script-mode.json";

/** Reads .claude/script-mode.json from the project root; missing/invalid -> defaults. */
function loadPolicy(cwd) {
	const base = defaultPolicy(cwd);
	const file = path.join(cwd, ".claude", POLICY_FILE);
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8"));
		return {
			...base,
			...raw,
			root: raw.root ? path.resolve(cwd, raw.root) : base.root,
			allowPaths: (raw.allowPaths ?? []).map(p => path.resolve(cwd, p)),
			bashDeny: raw.bashDeny ?? base.bashDeny,
		};
	} catch {
		return base;
	}
}

function deniedBashCommand(command, policy) {
	for (const pattern of policy.bashDeny) {
		try {
			if (new RegExp(pattern, "i").test(command)) return pattern;
		} catch {
			// invalid user pattern: ignore
		}
	}
	return undefined;
}

/** Resolves `p` against root, follows existing symlinks, verifies containment. */
function resolveInside(p, policy) {
	const abs = path.resolve(policy.root, String(p));
	const roots = [policy.root, ...policy.allowPaths];
	const inRoot = roots.some(r => abs === r || abs.startsWith(r + path.sep));
	if (!inRoot) throw new Error(`path outside allowed root: ${p}`);

	let probe = abs;
	while (!fs.existsSync(probe)) {
		const parent = path.dirname(probe);
		if (parent === probe) break;
		probe = parent;
	}
	const real = fs.realpathSync(probe);
	const under = roots.some(r => {
		const rr = safeRealpath(r);
		return real === rr || real.startsWith(rr + path.sep);
	});
	if (!under) throw new Error(`path escapes allowed root via symlink: ${p}`);
	return abs;
}

function safeRealpath(p) {
	try {
		return fs.realpathSync(p);
	} catch {
		return p;
	}
}

module.exports = { defaultPolicy, loadPolicy, deniedBashCommand, resolveInside };
