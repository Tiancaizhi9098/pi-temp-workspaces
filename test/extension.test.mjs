import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import * as sdk from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { registerTempWorkspaces } from "../extension.mjs";
import { WorkspaceManager, inside } from "../manager.mjs";
import { requestJanitorStop, janitorStatus } from "../janitor.mjs";

const testRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".runs");
fs.mkdirSync(testRoot, { recursive: true });

function environment(t, { project = false } = {}) {
  const base = fs.mkdtempSync(path.join(testRoot, "integration-"));
  const agentDir = path.join(base, "agent");
  const root = path.join(base, "Pi-Work");
  const home = path.join(base, "user-home");
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const titles = [];
  const notifications = [];
  let active = ["read", "write", "edit", "powershell"];
  const pi = {
    on: (name, fn) => handlers.set(name, fn),
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    getActiveTools: () => [...active],
    setActiveTools: (names) => { active = names; },
    getSettings: () => ({}),
  };
  const extension = registerTempWorkspaces(pi, { ...sdk, getAgentDir: () => agentDir }, { root, home, background: false });
  const context = (identity) => ({
    cwd: project ? path.join(base, "real-project") : root,
    sessionManager: {
      getSessionId: () => identity.sessionId,
      getSessionFile: () => identity.sessionFile,
    },
    ui: { notify: (message, type) => notifications.push({ message, type }), setStatus() {}, setTitle: title => titles.push(title) },
  });
  const session = () => ({ sessionId: crypto.randomUUID(), sessionFile: path.join(base, "sessions", `${crypto.randomUUID()}.jsonl`) });
  t.after(async () => {
    handlers.get("session_shutdown")?.();
    assert.ok(inside(testRoot, base) && base !== testRoot);
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { base, root, home, agentDir, handlers, tools, commands, titles, notifications, extension, context, session, active: () => active };
}

test("real Pi file tools use the per-conversation cwd and reject external writes", async (t) => {
  const f = environment(t);
  const ctx = f.context(f.session());
  f.handlers.get("session_start")({ reason: "startup" }, ctx);
  const workspace = f.extension.current.workspace;
  await f.tools.get("write").execute("write-1", { path: "nested/note.txt", content: "hello" }, undefined, undefined, ctx);
  assert.equal(fs.readFileSync(path.join(workspace, "nested", "note.txt"), "utf8"), "hello");
  assert.equal(fs.existsSync(path.join(f.root, "nested")), false);
  const read = await f.tools.get("read").execute("read-1", { path: "nested/note.txt" }, undefined, undefined, ctx);
  assert.equal(read.content[0].text, "hello");
  await assert.rejects(f.tools.get("write").execute("outside", { path: path.join(f.base, "wrong.txt"), content: "bad" }, undefined, undefined, ctx));
  assert.equal(fs.existsSync(path.join(f.base, "wrong.txt")), false);
  assert.deepEqual(f.active(), ["read", "write", "edit", "powershell"]);
});

test("real PowerShell tool starts in its conversation and uses local temp/cache", { skip: process.platform !== "win32" }, async (t) => {
  const f = environment(t);
  const ctx = f.context(f.session());
  f.handlers.get("session_start")({ reason: "startup" }, ctx);
  const workspace = f.extension.current.workspace;
  const result = await f.tools.get("powershell").execute("shell-1", {
    command: "Set-Content -LiteralPath shell-output.txt -Value 'created here'; [pscustomobject]@{ Cwd = (Get-Location).Path; Temp = $env:TEMP; Cache = $env:PIP_CACHE_DIR; Workspace = $env:PI_TEMP_WORKSPACE } | ConvertTo-Json -Compress",
    timeout: 15,
  }, undefined, undefined, ctx);
  const data = JSON.parse(result.content[0].text.trim());
  assert.equal(data.Cwd.toLowerCase(), workspace.toLowerCase());
  assert.equal(data.Temp, path.join(workspace, ".tmp"));
  assert.equal(data.Cache, path.join(workspace, ".cache", "pip"));
  assert.equal(data.Workspace, workspace);
  assert.equal(fs.existsSync(path.join(workspace, "shell-output.txt")), true);
});

test("/new allocates a different folder and resume reuses the old folder", (t) => {
  const f = environment(t);
  const first = f.session();
  f.handlers.get("session_start")({ reason: "startup" }, f.context(first));
  const a = f.extension.current.workspace;
  fs.writeFileSync(path.join(a, "keep.txt"), "first session");
  f.handlers.get("session_shutdown")({ reason: "new" });
  f.handlers.get("session_start")({ reason: "new" }, f.context(f.session()));
  const b = f.extension.current.workspace;
  assert.notEqual(a, b);
  f.handlers.get("session_shutdown")({ reason: "resume" });
  f.handlers.get("session_start")({ reason: "resume" }, f.context(first));
  assert.equal(f.extension.current.workspace, a);
  assert.equal(fs.readFileSync(path.join(a, "keep.txt"), "utf8"), "first session");
});

test("the model prompt receives the effective folder and output rules", (t) => {
  const f = environment(t);
  const ctx = f.context(f.session());
  f.handlers.get("session_start")({ reason: "startup" }, ctx);
  const event = { systemPromptOptions: { cwd: f.root, sections: {} } };
  f.handlers.get("before_agent_start")(event, ctx);
  assert.equal(event.systemPromptOptions.cwd, f.extension.current.workspace);
  assert.match(event.systemPromptOptions.sections.temporary_workspace, /Do not install global/);
  assert.match(event.systemPromptOptions.sections.temporary_workspace, /Playwriter/);
});

test("ordinary projects prepare Pi-Work without activating a workspace or changing cwd", (t) => {
  const f = environment(t, { project: true });
  const before = process.cwd();
  const ctx = f.context(f.session());
  f.handlers.get("session_start")({ reason: "startup" }, ctx);
  assert.equal(f.extension.current, null);
  assert.equal(f.tools.size, 0);
  assert.equal(fs.existsSync(f.root), true);
  assert.equal(fs.readdirSync(f.extension.manager.records).length, 0);
  assert.equal(process.cwd(), before);
});

test("a preparation failure is reported without breaking an ordinary project", async t => {
  const f = environment(t, { project: true });
  const before = process.cwd();
  fs.writeFileSync(f.root, "an existing file blocks directory creation");
  const ctx = f.context(f.session());
  f.handlers.get("session_start")({ reason: "startup" }, ctx);
  assert.equal(f.extension.current, null);
  assert.equal(process.cwd(), before);
  assert.equal(f.tools.size, 0);
  assert.equal(f.notifications.at(-1).type, "error");
  assert.doesNotThrow(() => f.handlers.get("before_agent_start")({ systemPromptOptions: { cwd: ctx.cwd, sections: {} } }, ctx));
  await f.commands.get("temp-work").handler("status", ctx);
  assert.match(f.notifications.at(-1).message, /准备失败/);
});

for (const location of ["home", "drive-root"]) {
  test(`starting in ${location} creates Pi-Work without a PowerShell profile helper`, async (t) => {
    const f = environment(t);
    const cwd = location === "home" ? f.home : path.parse(f.base).root;
    const ctx = { ...f.context(f.session()), cwd };
    assert.equal(fs.existsSync(f.root), false);
    f.handlers.get("session_start")({ reason: "startup" }, ctx);
    const record = f.extension.current;
    assert.ok(record);
    assert.equal(process.cwd(), record.workspace);
    assert.equal(inside(f.root, record.workspace), true);
    await f.tools.get("write").execute("auto-write", { path: "auto.txt", content: "temporary" }, undefined, undefined, ctx);
    assert.equal(fs.readFileSync(path.join(record.workspace, "auto.txt"), "utf8"), "temporary");
    const event = { systemPromptOptions: { cwd, sections: {} } };
    f.handlers.get("before_agent_start")(event, ctx);
    assert.equal(event.systemPromptOptions.cwd, record.workspace);
    await new Promise(setImmediate);
    assert.equal(f.titles.at(-1), "π - Pi-Work");
    ctx.sessionManager.getSessionName = () => "Demo";
    f.handlers.get("session_info_changed")({}, ctx);
    await new Promise(setImmediate);
    assert.equal(f.titles.at(-1), "π - Demo - Pi-Work");
  });
}

test("switching from a temporary session to a project restores ordinary file tools", async (t) => {
  const f = environment(t);
  const ctx = f.context(f.session());
  f.handlers.get("session_start")({ reason: "startup" }, ctx);
  const temporary = f.extension.current.workspace;
  f.handlers.get("session_shutdown")({ reason: "switch" });
  const project = path.join(f.base, "real-project");
  fs.mkdirSync(project);
  const projectCtx = { ...f.context(f.session()), cwd: project };
  f.handlers.get("session_start")({ reason: "switch" }, projectCtx);
  assert.equal(f.extension.current, null);
  await f.tools.get("write").execute("project-write", { path: "project.txt", content: "in project" }, undefined, undefined, projectCtx);
  assert.equal(fs.readFileSync(path.join(project, "project.txt"), "utf8"), "in project");
  assert.equal(fs.existsSync(path.join(temporary, "project.txt")), false);
});

test("a deleted live conversation cannot silently recreate its transcript", (t) => {
  const f = environment(t);
  const identity = f.session();
  fs.mkdirSync(path.dirname(identity.sessionFile), { recursive: true });
  fs.writeFileSync(identity.sessionFile, JSON.stringify({ type: "session", version: 3, id: identity.sessionId }) + "\n");
  const ctx = f.context(identity);
  f.handlers.get("session_start")({ reason: "startup" }, ctx);
  fs.unlinkSync(identity.sessionFile);
  assert.deepEqual(f.handlers.get("input")({ text: "continue" }, ctx), { action: "handled" });
});

test("background cleanup works independently after a Magpie-style move", async (t) => {
  const f = environment(t);
  const manager = new WorkspaceManager({ agentDir: f.agentDir, root: f.root, graceMs: 100 }).initialize();
  const identity = f.session();
  fs.mkdirSync(path.dirname(identity.sessionFile), { recursive: true });
  fs.writeFileSync(identity.sessionFile, JSON.stringify({ type: "session", version: 3, id: identity.sessionId, cwd: f.root }) + "\n");
  const record = manager.bind(identity);
  fs.writeFileSync(path.join(record.workspace, "output.txt"), "temporary");
  const runner = path.join(f.base, "run-janitor.mjs");
  const janitorUrl = new URL("../janitor.mjs", import.meta.url).href;
  fs.writeFileSync(runner, `import { runJanitor } from ${JSON.stringify(janitorUrl)};\nrunJanitor(${JSON.stringify({ agentDir: f.agentDir, root: f.root, graceMs: 100, intervalMs: 50 })});\n`);
  const child = spawn(process.execPath, [runner], { stdio: "ignore", windowsHide: true });
  const closed = new Promise((resolve) => child.once("exit", resolve));
  try {
    fs.renameSync(identity.sessionFile, path.join(f.base, "magpie-trash.jsonl"));
    const deadline = Date.now() + 5000;
    while (fs.existsSync(record.workspace) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(fs.existsSync(record.workspace), false);
    assert.equal(fs.existsSync(path.join(f.base, "magpie-trash.jsonl")), true);
    assert.equal(janitorStatus(manager.state).running, true);
    assert.equal(requestJanitorStop(manager.state), true);
    const timeout = new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Janitor did not stop.")), 2000); timer.unref(); });
    assert.equal(await Promise.race([closed, timeout]), 0);
    assert.equal(janitorStatus(manager.state).running, false);
  } finally {
    child.kill("SIGTERM");
    await closed;
  }
});
