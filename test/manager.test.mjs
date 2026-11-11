import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WorkspaceManager, MARKER, assertWorkspaceWrite, inside, canonicalPath } from "../manager.mjs";
import { acquireJanitorLock, janitorStatus, requestJanitorStop } from "../janitor.mjs";

const testRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".runs");
fs.mkdirSync(testRoot, { recursive: true });
function fixture(t) {
  const base = fs.mkdtempSync(path.join(testRoot, "case-"));
  let clock = 100000;
  const manager = new WorkspaceManager({
    agentDir: path.join(base, "agent"), root: path.join(base, "Pi-Work"),
    graceMs: 1000, now: () => clock,
  }).initialize();
  const releases = [];
  t.after(() => {
    for (const release of releases) { try { release(); } catch {} }
    assert.ok(inside(testRoot, base) && base !== testRoot);
    fs.rmSync(base, { recursive: true, force: true });
  });
  const session = () => {
    const sessionId = crypto.randomUUID();
    const sessionFile = path.join(base, "sessions", `${sessionId}.jsonl`);
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    return { sessionId, sessionFile };
  };
  const persist = (identity) => fs.writeFileSync(identity.sessionFile, JSON.stringify({ type: "session", version: 3, id: identity.sessionId, cwd: manager.root }) + "\n");
  const expire = () => { manager.sweep(); clock += 1001; return manager.sweep(); };
  return { base, manager, session, persist, expire, advance: () => { clock += 1001; }, releases };
}

test("new conversations get separate folders; resume keeps files", (t) => {
  const f = fixture(t);
  const a = f.session();
  const first = f.manager.bind(a);
  fs.writeFileSync(path.join(first.workspace, "notes.txt"), "keep");
  const second = f.manager.bind(f.session());
  const resumed = f.manager.bind(a);
  assert.notEqual(first.workspace, second.workspace);
  assert.equal(first.workspace, resumed.workspace);
  assert.equal(first.token, resumed.token);
  assert.equal(fs.readFileSync(path.join(resumed.workspace, "notes.txt"), "utf8"), "keep");
  assert.equal(f.manager.eligible(f.manager.root), true);
  assert.equal(f.manager.eligible(path.join(f.base, "project")), false);
});

test("Magpie-style transcript move cleans only the matching owned folder", (t) => {
  const f = fixture(t);
  const a = f.session(); f.persist(a);
  const record = f.manager.bind(a);
  const other = f.manager.bind(f.session());
  const otherLease = f.manager.acquire(other); f.releases.push(otherLease);
  fs.writeFileSync(path.join(f.manager.root, "existing-user-file.md"), "untouched");
  fs.writeFileSync(path.join(record.workspace, "output.txt"), "temporary");
  const trash = path.join(f.base, "magpie-trash.jsonl");
  fs.renameSync(a.sessionFile, trash);
  assert.deepEqual(f.manager.sweep().removed, []);
  f.advance();
  assert.deepEqual(f.manager.sweep().removed, [record.workspace]);
  assert.equal(fs.existsSync(record.workspace), false);
  assert.equal(fs.existsSync(other.workspace), true);
  assert.equal(fs.existsSync(trash), true);
  assert.equal(fs.readFileSync(path.join(f.manager.root, "existing-user-file.md"), "utf8"), "untouched");
});

test("live conversations and leases are preserved after transcript deletion", (t) => {
  const f = fixture(t);
  const s = f.session(); f.persist(s);
  const record = f.manager.bind(s);
  const release = f.manager.acquire(record);
  fs.unlinkSync(s.sessionFile);
  assert.deepEqual(f.expire().removed, []);
  assert.equal(fs.existsSync(record.workspace), true);
  release();
  assert.deepEqual(f.expire().removed, [record.workspace]);
});

test("an unopened empty conversation is cleaned only after release and grace", (t) => {
  const f = fixture(t);
  const record = f.manager.bind(f.session());
  const release = f.manager.acquire(record);
  assert.deepEqual(f.expire().removed, []);
  release();
  assert.deepEqual(f.expire().removed, [record.workspace]);
});

test("a restored transcript cancels pending cleanup", (t) => {
  const f = fixture(t);
  const s = f.session(); f.persist(s);
  const record = f.manager.bind(s);
  fs.unlinkSync(s.sessionFile);
  f.manager.sweep();
  f.persist(s);
  f.advance();
  assert.deepEqual(f.manager.sweep().removed, []);
  assert.equal(fs.existsSync(record.workspace), true);
  assert.equal(f.manager.get(record.key).missingSince, null);
});

test("changed or unreadable transcript headers never authorize deletion", (t) => {
  const f = fixture(t);
  const s = f.session(); f.persist(s);
  const record = f.manager.bind(s);
  fs.writeFileSync(s.sessionFile, "invalid JSON");
  assert.deepEqual(f.expire().removed, []);
  fs.writeFileSync(s.sessionFile, JSON.stringify({ type: "session", id: "somebody-else" }));
  assert.deepEqual(f.expire().removed, []);
  assert.equal(fs.existsSync(record.workspace), true);
});

test("a damaged ownership marker preserves the folder", (t) => {
  const f = fixture(t);
  const record = f.manager.bind(f.session());
  fs.writeFileSync(path.join(record.workspace, MARKER), JSON.stringify({ token: "wrong" }));
  const report = f.expire();
  assert.equal(report.removed.length, 0);
  assert.equal(report.errors.length, 1);
  assert.equal(fs.existsSync(record.workspace), true);
});

test("a forged external workspace record cannot delete a project", (t) => {
  const f = fixture(t);
  const record = f.manager.bind(f.session());
  const project = path.join(f.base, "important-project");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "keep.txt"), "keep");
  fs.writeFileSync(f.manager.recordPath(record.key), JSON.stringify({ ...record, workspace: project }));
  assert.equal(f.expire().removed.length, 0);
  assert.equal(fs.readFileSync(path.join(project, "keep.txt"), "utf8"), "keep");
});

test("existing unregistered directories are never adopted", (t) => {
  const f = fixture(t);
  const s = f.session();
  const folder = path.join(f.manager.root, `session-${f.manager.keyFor(s.sessionId, s.sessionFile)}`);
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, "keep"), "keep");
  assert.throws(() => f.manager.bind(s), /exist/i);
  assert.equal(fs.existsSync(path.join(folder, "keep")), true);
});

test("output guard rejects parent paths, external absolute paths, and marker edits", (t) => {
  const f = fixture(t);
  const record = f.manager.bind(f.session());
  assert.equal(assertWorkspaceWrite(record.workspace, "nested/result.txt"), path.join(record.workspace, "nested", "result.txt"));
  assert.throws(() => assertWorkspaceWrite(record.workspace, "../bad.txt"));
  assert.throws(() => assertWorkspaceWrite(record.workspace, path.join(f.base, "bad.txt")));
  assert.throws(() => assertWorkspaceWrite(record.workspace, MARKER));
});

test("directory links cannot escape the output guard or be followed during cleanup", (t) => {
  const f = fixture(t);
  const record = f.manager.bind(f.session());
  const external = path.join(f.base, "external");
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, "keep.txt"), "keep");
  const link = path.join(record.workspace, "outside-link");
  fs.symlinkSync(external, link, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => assertWorkspaceWrite(record.workspace, "outside-link/changed.txt"));
  assert.deepEqual(f.expire().removed, [record.workspace]);
  assert.equal(fs.readFileSync(path.join(external, "keep.txt"), "utf8"), "keep");
});

test("replacing a whole workspace with a link blocks cleanup", (t) => {
  const f = fixture(t);
  const record = f.manager.bind(f.session());
  const moved = path.join(f.base, "original-folder");
  fs.renameSync(record.workspace, moved);
  fs.symlinkSync(moved, record.workspace, process.platform === "win32" ? "junction" : "dir");
  assert.equal(f.expire().removed.length, 0);
  assert.equal(fs.existsSync(path.join(moved, MARKER)), true);
});

test("a locked payload leaves its ownership marker for a later retry", (t) => {
  const f = fixture(t);
  const record = f.manager.bind(f.session());
  const payload = path.join(record.workspace, "locked.txt");
  fs.writeFileSync(payload, "busy");
  f.manager.sweep(); f.advance();
  const original = fs.rmSync;
  const replacement = t.mock.method(fs, "rmSync", (target, options) => {
    if (target === payload) throw Object.assign(new Error("file busy"), { code: "EBUSY" });
    return original(target, options);
  });
  assert.equal(f.manager.sweep().errors.length, 1);
  assert.equal(fs.existsSync(path.join(record.workspace, MARKER)), true);
  replacement.mock.restore();
  assert.deepEqual(f.manager.sweep().removed, [record.workspace]);
});

test("only one janitor claims a state directory", (t) => {
  const f = fixture(t);
  const first = acquireJanitorLock(f.manager.state);
  assert.ok(first);
  assert.equal(acquireJanitorLock(f.manager.state), null);
  first.release();
  const replacement = acquireJanitorLock(f.manager.state);
  assert.ok(replacement);
  replacement.release();
});

test("Windows short TEMP aliases and the full user-profile path select the same root", { skip: process.platform !== "win32" }, (t) => {
  const f = fixture(t);
  // Node inherits an 8.3 TEMP alias on some Windows launches.
  const nodeTemp = path.join(os.tmpdir(), "Pi-Work");
  const fullTemp = path.join(canonicalPath(os.tmpdir()), "Pi-Work");
  const manager = new WorkspaceManager({ agentDir: path.join(f.base, "agent"), root: nodeTemp });
  assert.equal(manager.eligible(fullTemp), true);
  assert.equal(canonicalPath(nodeTemp).toLowerCase(), canonicalPath(fullTemp).toLowerCase());
});

test("resume recreates an OS-removed workspace while retaining its session identity", (t) => {
  const f = fixture(t);
  const s = f.session(); f.persist(s);
  const record = f.manager.bind(s);
  assert.ok(inside(f.manager.root, record.workspace) && record.workspace !== f.manager.root);
  fs.rmSync(record.workspace, { recursive: true });
  const resumed = f.manager.bind(s);
  assert.equal(resumed.key, record.key);
  assert.equal(fs.existsSync(path.join(resumed.workspace, MARKER)), true);
  assert.deepEqual(f.manager.sweep().removed, []);
});

test("cleanup retires records for folders already removed by the OS", (t) => {
  const f = fixture(t);
  const record = f.manager.bind(f.session());
  assert.ok(inside(f.manager.root, record.workspace) && record.workspace !== f.manager.root);
  fs.rmSync(record.workspace, { recursive: true });
  const report = f.expire();
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.removed, [record.workspace]);
  assert.equal(fs.existsSync(f.manager.recordPath(record.key)), false);
});

test("custom scratch roots keep separate state and cleanup processes", (t) => {
  const f = fixture(t);
  const other = new WorkspaceManager({ agentDir: f.manager.agentDir, root: path.join(f.base, "other-root") }).initialize();
  const firstRecord = f.manager.bind(f.session());
  const secondRecord = other.bind(f.session());
  assert.notEqual(other.state, f.manager.state);
  assert.equal(fs.existsSync(f.manager.recordPath(secondRecord.key)), false);
  const firstLock = acquireJanitorLock(f.manager.state);
  const otherLock = acquireJanitorLock(other.state);
  try {
    assert.ok(firstLock && otherLock);
    assert.equal(janitorStatus(other.state).running, true);
    assert.equal(requestJanitorStop(other.state), true);
    assert.equal(fs.existsSync(path.join(f.manager.state, "stop.json")), false);
    assert.equal(fs.existsSync(firstRecord.workspace), true);
  } finally { firstLock?.release(); otherLock?.release(); }
});

test("an old truncated janitor lock is quarantined; a recent write is left alone", (t) => {
  const f = fixture(t);
  const lockFile = path.join(f.manager.state, "janitor.json");
  fs.writeFileSync(lockFile, "{");
  assert.equal(acquireJanitorLock(f.manager.state), null);
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lockFile, old, old);
  const lock = acquireJanitorLock(f.manager.state);
  try {
    assert.ok(lock);
    assert.equal(fs.readdirSync(f.manager.state).filter((name) => name.startsWith("janitor.json.damaged-")).length, 1);
  } finally { lock?.release(); }
});
