import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inside, WorkspaceManager } from "../manager.mjs";

for (const mode of ["standalone", "package", "home", "drive-root", "project"]) {
test(`installed Pi loads the ${mode} package and handles actual RPC new/resume transitions`, { timeout: 25000 }, async () => {
  const suite = path.dirname(fileURLToPath(import.meta.url));
  const testRoot = path.join(suite, ".runs");
  fs.mkdirSync(testRoot, { recursive: true });
  const base = fs.mkdtempSync(path.join(testRoot, "rpc-"));
  const agentDir = path.join(base, "agent");
  const root = path.join(base, "Pi-Work");
  const project = path.join(base, "project");
  fs.mkdirSync(project);
  const launchCwd = mode === "home" ? os.homedir() : mode === "drive-root" ? path.parse(suite).root : mode === "project" ? project : root;
  if (launchCwd === root) fs.mkdirSync(root, { recursive: true });
  const sdkEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const packageDir = path.dirname(path.dirname(sdkEntry));
  const packageInfo = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
  const bin = typeof packageInfo.bin === "string" ? packageInfo.bin : packageInfo.bin.pi;
  const launcher = path.resolve(packageDir, bin);
  const extraArgs = [];
  if (mode === "standalone") {
    const extensionDir = path.join(agentDir, "extensions", "pi-temp-workspaces");
    fs.mkdirSync(extensionDir, { recursive: true });
    for (const file of ["index.js", "extension.mjs", "manager.mjs", "janitor.mjs", "package.json"]) {
      fs.copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), path.join(extensionDir, file));
    }
  } else {
    extraArgs.push("-e", path.resolve(suite, ".."));
  }
  const child = spawn(process.execPath, [launcher, "--mode", "rpc", "--offline", ...extraArgs], {
    cwd: launchCwd, windowsHide: true,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_TEMP_WORK_ROOT: root, PI_TEMP_WORK_BACKGROUND: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let stderr = "";
  let sequence = 0;
  const pending = new Map();
  child.stdout.on("data", (data) => {
    buffer += data.toString();
    for (let index; (index = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id && pending.has(message.id)) {
        const request = pending.get(message.id); pending.delete(message.id);
        clearTimeout(request.timer); request.resolve(message);
      }
    }
  });
  child.stderr.on("data", (data) => { stderr += data.toString(); });
  const closed = new Promise((resolve) => child.once("exit", resolve));
  const request = (type, extra = {}) => new Promise((resolve, reject) => {
    const id = `test-${++sequence}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC ${type} timed out. ${stderr}`)); }, 10000);
    pending.set(id, { resolve, timer });
    child.stdin.write(JSON.stringify({ id, type, ...extra }) + "\n");
  });
  try {
    const initial = await request("get_state");
    assert.equal(initial.success, true, JSON.stringify(initial));
    const commands = await request("get_commands");
    assert.equal(commands.success, true, JSON.stringify(commands));
    assert.match(JSON.stringify(commands), /temp-work/);
    if (mode === "project") {
      assert.equal(fs.existsSync(root), false, "Project startup must not activate a temporary workspace.");
      return;
    }
    assert.doesNotMatch(JSON.stringify(commands), /model-system|"goal"/);
    const records = new WorkspaceManager({ agentDir, root }).records;
    const list = () => fs.readdirSync(records).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(fs.readFileSync(path.join(records, name), "utf8")));
    assert.equal(list().length, 1, stderr);
    const first = list()[0];
    fs.mkdirSync(path.dirname(first.sessionFile), { recursive: true });
    fs.writeFileSync(first.sessionFile, JSON.stringify({ type: "session", version: 3, id: first.sessionId, timestamp: new Date().toISOString(), cwd: launchCwd }) + "\n");
    fs.writeFileSync(path.join(first.workspace, "keep.txt"), "first conversation");
    const created = await request("new_session");
    assert.equal(created.success, true, JSON.stringify(created));
    assert.equal(list().length, 2, stderr);
    const switched = await request("switch_session", { sessionPath: first.sessionFile });
    assert.equal(switched.success, true, JSON.stringify(switched));
    assert.equal(list().length, 2);
    assert.equal(fs.readFileSync(path.join(first.workspace, "keep.txt"), "utf8"), "first conversation");
    assert.doesNotMatch(stderr, /failed to load|extension error/i);
  } finally {
    for (const request of pending.values()) clearTimeout(request.timer);
    child.kill("SIGTERM");
    await closed;
    assert.ok(inside(testRoot, base) && base !== testRoot);
    fs.rmSync(base, { recursive: true, force: true });
  }
});
}
