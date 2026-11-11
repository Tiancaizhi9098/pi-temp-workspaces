import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WorkspaceManager, OWNER, readJSON } from "./manager.mjs";

export function janitorStatus(state) {
  try {
    const lock = readJSON(path.join(state, "janitor.json"));
    if (lock.owner !== OWNER || !Number.isSafeInteger(lock.pid) || lock.pid <= 0 || typeof lock.token !== "string") {
      return { running: null, message: "Invalid cleanup-process lock." };
    }
    try { process.kill(lock.pid, 0); return { running: true, pid: lock.pid }; }
    catch (error) { return { running: error.code === "ESRCH" ? false : null, pid: lock.pid }; }
  } catch (error) {
    return error.code === "ENOENT" ? { running: false } : { running: null, message: error.message };
  }
}

export function requestJanitorStop(state) {
  const file = path.join(state, "janitor.json");
  if (!fs.existsSync(file)) return false;
  const lock = readJSON(file);
  if (lock.owner !== OWNER || typeof lock.token !== "string") throw new Error("Unrecognized cleanup-process lock.");
  fs.writeFileSync(path.join(state, "stop.json"), JSON.stringify({ token: lock.token }));
  return true;
}

export function acquireJanitorLock(state) {
  const file = path.join(state, "janitor.json");
  const token = crypto.randomUUID();
  const value = { owner: OWNER, pid: process.pid, token, startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx");
      try { fs.writeFileSync(fd, JSON.stringify(value)); } finally { fs.closeSync(fd); }
      return { ...value, release() {
        try { if (readJSON(file).token === token) fs.unlinkSync(file); } catch { /* already released */ }
      } };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // A new lock may still be in the synchronous write window. Older damaged
      // locks are retained for diagnosis and no longer disable cleanup forever.
      let previous;
      try { previous = readJSON(file); }
      catch (readError) {
        if (!(readError instanceof SyntaxError)) return null;
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || Date.now() - stat.mtimeMs < 30000) return null;
        try { fs.renameSync(file, `${file}.damaged-${crypto.randomUUID()}`); }
        catch { return null; }
        continue;
      }
      if (previous.owner !== OWNER || !Number.isSafeInteger(previous.pid) || previous.pid <= 0) return null;
      try { process.kill(previous.pid, 0); return null; }
      catch (probe) { if (probe.code !== "ESRCH") return null; }
      try { fs.unlinkSync(file); } catch (remove) { if (remove.code !== "ENOENT") return null; }
    }
  }
  return null;
}

export function runJanitor(options) {
  const manager = new WorkspaceManager(options).initialize();
  const lock = acquireJanitorLock(manager.state);
  if (!lock) return null;
  const stopFile = path.join(manager.state, "stop.json");
  const logFile = path.join(manager.state, "cleanup.log");
  const log = (value) => {
    try {
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 128 * 1024) fs.truncateSync(logFile, 0);
      fs.appendFileSync(logFile, JSON.stringify({ time: new Date().toISOString(), ...value }) + "\n");
    } catch { /* Diagnostics must not make cleanup destructive or crash Pi. */ }
  };
  const stop = () => {
    clearInterval(timer);
    watcher?.close();
    lock.release();
  };
  let watcher;
  const tick = () => {
    try {
      if (fs.existsSync(stopFile) && readJSON(stopFile).token === lock.token) {
        fs.unlinkSync(stopFile);
        stop();
        return;
      }
      const report = manager.sweep();
      if (report.removed.length || report.errors.length) log(report);
    } catch (error) { log({ error: error.message }); }
  };
  const timer = setInterval(tick, options.intervalMs ?? 3000);
  // Polling is authoritative. The watcher simply reduces latency when records change.
  try { watcher = fs.watch(manager.records, { persistent: true }, tick); }
  catch { /* Windows polling also handles transcript moves by Magpie. */ }
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.once("exit", () => lock.release());
  tick();
  return { stop, manager, lock };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  const agentDir = arg("--agent-dir");
  if (!agentDir) throw new Error("--agent-dir is required.");
  const options = { agentDir, root: arg("--root") };
  if (process.argv.includes("--once")) {
    console.log(JSON.stringify(new WorkspaceManager(options).initialize().sweep()));
  } else if (process.argv.includes("--stop")) {
    const manager = new WorkspaceManager(options).initialize();
    console.log(JSON.stringify({ requested: requestJanitorStop(manager.state) }));
  } else if (process.argv.includes("--status")) {
    const manager = new WorkspaceManager(options).initialize();
    console.log(JSON.stringify(janitorStatus(manager.state)));
  } else {
    runJanitor(options);
  }
}
