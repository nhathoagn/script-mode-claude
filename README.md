# claude-script-mode

Programmatic tool calling (PTC) for Claude Code — port of
[omp-script-mode](../omp-script-mode) as a standalone MCP plugin.

Instead of the model calling tools one JSON invocation at a time (each
round-trip re-sending the whole context), the model writes one JavaScript
program. The program runs in a sandboxed `node --permission` subprocess, calls
the host via a stdio JSON-RPC bridge, and only what it explicitly `text()`
prints ever reaches the model's context.

## Tools

| Tool | Purpose |
|---|---|
| `script` | Run a JS program that batches file/shell work. `background: true` detaches it; poll with `script_status`. |
| `script_status` | Check a background job's state, tail its log. |
| `script_cancel` | Kill a running background job. |

In-script API (all async, `await` them):

```js
read(path)                 // file contents
write(path, content)       // { path, bytes }
edit(path, from, to, {all})// unique string replace (all: true for global)
grep(pattern, {root,glob}) // rg output
glob(pattern, {root})      // string[]
bash(command, {timeoutMs}) // stdout
text(s)                    // print to the model's context (the only data it sees)
sleep(ms)
```

## When to use

The tool description carries the trigger: **≥4 same-shape calls or >10KB of
tool output**. Below that, direct tool calls are cheaper — a run that ends up
small returns a `script note` hint so the model self-corrects. Measured on the
omp port: 24×200-line files cost ~12K tokens via `script` vs ~190K via
sequential reads.

## Sandbox

- `node --permission`: the script can only read `runner.cjs` and its own code
  file — every fs/bash access goes through the bridge.
- `vm.createContext` isolates globals; `require`/`process`/`import()` absent.
- Paths confined to the project root (`CLAUDE_PROJECT_DIR` or cwd);
  `bash()` has a regex denylist.
- Policy: `.claude/script-mode.json` in the project root:

```json
{
	"writable": true,
	"allowBash": true,
	"bashDeny": ["\\bgit\\s+push\\b"],
	"allowPaths": [],
	"maxScriptMs": 480000,
	"bashTimeoutMs": 150000,
	"maxTextBytes": 16384,
	"maxResultBytes": 262144
}
```

- Logs: every bridged call and `console.*` lands in
  `.claude/script-logs/<run>.log`.

## Install

Requires `node` ≥ 22 on PATH (`--permission`, `fs.promises.glob`).

```bash
# as a plugin
claude plugin add /path/to/claude-script-mode
# or register the MCP server directly
claude mcp add script-mode -- node /path/to/claude-script-mode/server.js
```

## Differences vs the omp version

- Background jobs are poll-only (`script_status`) — MCP cannot wake the model
  with an aside message.
- No `loadMode: "essential"` equivalent: the MCP tool description is the
  context cost; it is kept ~700 bytes.

## Example

```js
const files = await glob("data/**/*.log");
const counts = {};
for (const f of files) {
  const src = await read(f);
  counts[f] = src.split("\n").filter(l => l.includes("ERROR")).length;
}
text(JSON.stringify(counts));
```
