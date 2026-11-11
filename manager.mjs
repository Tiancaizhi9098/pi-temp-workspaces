import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export const OWNER = "pi-temp-workspaces-local/v1";
export const MARKER = ".pi-temp-workspace.json";
const KEY_RE = /^[a-f0-9]{32}$/;
const UUID_RE = /^[a-f0-9-]{36}$/i;

export function canonicalPath(input) {
  let ancestor = path.resolve(input);
  const suffix = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(ancestor), ...suffix.reverse()); }
    catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return path.resolve(input);
      suffix.push(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

export function samePath(a, b) {
  const normalize = (p) => {
    const value = canonicalPath(p);
    return process.platform === "win32" ? value.toLowerCase() : value;
  };
  return normalize(a) === normalize(b);
}

export function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function atomicJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function status(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

export class WorkspaceManager {
  constructor({ agentDir, root = process.env.PI_TEMP_WORK_ROOT || path.join(os.tmpdir(), "Pi-Work"), home = os.homedir(), graceMs = 10000, now = () => Date.now() }) {
    this.agentDir = canonicalPath(agentDir);
    this.root = canonicalPath(root);
    this.home = canonicalPath(home);
    const stateBase = path.join(this.agentDir, "state", "pi-temp-workspaces");
    // Preserve the original default-root registry, while custom roots cannot
    // share records or a background lock with a different scratch location.
    const defaultRoot = canonicalPath(path.join(os.tmpdir(), "Pi-Work"));
    const rootIdentity = process.platform === "win32" ? this.root.toLowerCase() : this.root;
    this.state = samePath(this.root, defaultRoot) ? stateBase
      : path.join(stateBase, "roots", crypto.createHash("sha256").update(rootIdentity).digest("hex").slice(0, 32));
    this.records = path.join(this.state, "records");
    this.leases = path.join(this.state, "leases");
    this.graceMs = graceMs;
    this.now = now;
  }

  initialize() {
    for (const dir of [this.root, this.state, this.records, this.leases]) {
      fs.mkdirSync(dir, { recursive: true });
      const stat = fs.lstatSync(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Expected an ordinary directory: ${dir}`);
    }
    this.rootReal = fs.realpathSync.native(this.root);
    return this;
  }

  eligible(cwd) {
    const current = canonicalPath(cwd);
    return samePath(current, this.root) || samePath(current, this.home)
      || samePath(current, path.parse(current).root);
  }

  keyFor(sessionId, sessionFile) {
    const file = sessionFile ? canonicalPath(sessionFile) : `ephemeral:${sessionId}`;
    const identity = process.platform === "win32" ? file.toLowerCase() : file;
    return crypto.createHash("sha256").update(`${sessionId}\n${identity}`).digest("hex").slice(0, 32);
  }

  recordPath(key) {
    if (!KEY_RE.test(key)) throw new Error("Invalid workspace identity.");
    return path.join(this.records, `${key}.json`);
  }

  validateRecord(record) {
    if (record?.owner !== OWNER || !KEY_RE.test(record.key) || !UUID_RE.test(record.token)) throw new Error("Unrecognized workspace record.");
    if (record.key !== this.keyFor(record.sessionId, record.sessionFile)) throw new Error("Session identity does not match its record.");
    if (!samePath(record.workspace, path.join(this.root, `session-${record.key}`))) throw new Error("Workspace is outside its owned location.");
    return record;
  }

  get(key) { return this.validateRecord(readJSON(this.recordPath(key))); }

  validateFolder(record) {
    this.validateRecord(record);
    const rootStat = fs.lstatSync(this.root);
    if (rootStat.isSymbolicLink() || !samePath(fs.realpathSync.native(this.root), this.rootReal ?? fs.realpathSync.native(this.root))) throw new Error("Scratch root changed.");
    const stat = fs.lstatSync(record.workspace);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Workspace was replaced with a link or file.");
    const real = fs.realpathSync.native(record.workspace);
    if (!inside(fs.realpathSync.native(this.root), real) || samePath(real, fs.realpathSync.native(this.root))) throw new Error("Unsafe workspace path.");
    const markerPath = path.join(record.workspace, MARKER);
    const markerStat = fs.lstatSync(markerPath);
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error("Invalid ownership marker.");
    const marker = readJSON(markerPath);
    if (marker.owner !== OWNER || marker.key !== record.key || marker.token !== record.token) throw new Error("Workspace ownership does not match.");
    return record.workspace;
  }

  bind({ sessionId, sessionFile }) {
    if (typeof sessionId !== "string" || !sessionId.length || sessionId.length > 200) throw new Error("Invalid Pi session ID.");
    const key = this.keyFor(sessionId, sessionFile);
    const recordPath = this.recordPath(key);
    if (status(recordPath)) {
      const existing = this.get(key);
      // OS temporary-directory cleanup can remove files while the Pi transcript
      // remains. Resume into a fresh empty folder, never adopt an existing one.
      if (!status(existing.workspace)) {
        fs.mkdirSync(existing.workspace);
        atomicJSON(path.join(existing.workspace, MARKER), { owner: OWNER, key, token: existing.token });
      }
      this.validateFolder(existing);
      this.observe(key);
      return this.get(key);
    }
    const workspace = path.join(this.root, `session-${key}`);
    // Never adopt an existing unregistered directory, even if its name matches.
    fs.mkdirSync(workspace);
    const record = {
      owner: OWNER, key, token: crypto.randomUUID(), sessionId,
      sessionFile: sessionFile ? canonicalPath(sessionFile) : null,
      workspace, createdAt: this.now(), seenSession: false, missingSince: null,
    };
    atomicJSON(path.join(workspace, MARKER), { owner: OWNER, key, token: record.token });
    atomicJSON(recordPath, record);
    this.observe(key);
    return this.get(key);
  }

  sessionState(record) {
    if (!record.sessionFile) return "missing";
    try {
      const fd = fs.openSync(record.sessionFile, "r");
      try {
        const data = Buffer.alloc(16384);
        const bytes = fs.readSync(fd, data, 0, data.length, 0);
        const header = JSON.parse(data.subarray(0, bytes).toString("utf8").split("\n")[0]);
        if (header.type !== "session" || header.id !== record.sessionId) return "unknown";
        return "present";
      } finally { fs.closeSync(fd); }
    } catch (error) {
      return error.code === "ENOENT" ? "missing" : "unknown";
    }
  }

  observe(key) {
    const record = this.get(key);
    const current = this.sessionState(record);
    if (current === "present" && (!record.seenSession || record.missingSince !== null)) {
      atomicJSON(this.recordPath(key), { ...record, seenSession: true, missingSince: null });
    }
    return current;
  }

  acquire(record) {
    this.validateFolder(record);
    const leasePath = path.join(this.leases, `${record.key}.${process.pid}.${crypto.randomUUID()}.json`);
    atomicJSON(leasePath, { owner: OWNER, key: record.key, token: record.token, pid: process.pid });
    return () => {
      try { this.observe(record.key); }
      finally {
        try { fs.unlinkSync(leasePath); } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    };
  }

  hasLease(record) {
    for (const name of fs.readdirSync(this.leases)) {
      if (!name.startsWith(record.key + ".") || !name.endsWith(".json")) continue;
      const lease = readJSON(path.join(this.leases, name));
      if (lease.owner !== OWNER || lease.key !== record.key || lease.token !== record.token) throw new Error("Unrecognized workspace lease.");
      if (alive(lease.pid)) return true;
    }
    return false;
  }

  sweep() {
    const report = { removed: [], pending: [], errors: [] };
    for (const name of fs.readdirSync(this.records)) {
      if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
      try {
        const record = this.get(name.slice(0, -5));
        const current = this.observe(record.key);
        if (current !== "missing") continue; // Unreadable or changed files are preserved.
        if (this.hasLease(record)) { report.pending.push(record.key); continue; }
        if (record.missingSince === null) {
          atomicJSON(this.recordPath(record.key), { ...record, missingSince: this.now() });
          report.pending.push(record.key);
          continue;
        }
        if (this.now() - record.missingSince < this.graceMs) { report.pending.push(record.key); continue; }
        // Re-read immediately before deletion. Only this exact owned direct child is removable.
        const fresh = this.get(record.key);
        if (this.sessionState(fresh) !== "missing" || this.hasLease(fresh)) continue;
        const target = fresh.workspace;
        if (status(target)) {
          this.validateFolder(fresh);
          // Keep the marker until all payload items are gone, so locked files
          // can be retried without losing proof of ownership.
          for (const item of fs.readdirSync(target)) {
            if (item === MARKER) continue;
            const child = path.resolve(target, item);
            if (!samePath(path.dirname(child), target)) throw new Error("Unsafe cleanup child.");
            this.validateFolder(fresh);
            fs.rmSync(child, { recursive: true, force: false, maxRetries: 2, retryDelay: 100 });
          }
          const markerPath = path.join(target, MARKER);
          fs.unlinkSync(markerPath);
          try { fs.rmdirSync(target); }
          catch (error) {
            atomicJSON(markerPath, { owner: OWNER, key: fresh.key, token: fresh.token });
            throw error;
          }
        }
        fs.unlinkSync(this.recordPath(fresh.key));
        for (const lease of fs.readdirSync(this.leases)) {
          if (lease.startsWith(fresh.key + ".") && lease.endsWith(".json")) fs.unlinkSync(path.join(this.leases, lease));
        }
        report.removed.push(target);
      } catch (error) { report.errors.push({ record: name, message: error.message }); }
    }
    return report;
  }
}

export function assertWorkspaceWrite(workspace, input) {
  if (typeof input !== "string" || !input.length) throw new Error("A file path is required.");
  const expanded = input === "~" ? os.homedir() : /^~[\\/]/.test(input) ? path.join(os.homedir(), input.slice(2)) : input;
  const target = path.resolve(workspace, expanded);
  if (!inside(workspace, target) || samePath(workspace, target) || samePath(path.join(workspace, MARKER), target)) {
    throw new Error(`This temporary conversation writes files only inside ${workspace}. Save the file there; export or move it yourself when finished.`);
  }
  let ancestor = target;
  while (!status(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error("Cannot resolve the output path.");
    ancestor = parent;
  }
  if (!inside(fs.realpathSync.native(workspace), fs.realpathSync.native(ancestor))) throw new Error("Output path follows a link outside this conversation's folder.");
  return target;
}
