import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inside } from "../manager.mjs";

const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const testRoot = path.join(source, "test", ".runs");
fs.mkdirSync(testRoot, { recursive: true });
function fixture(t) {
  const base = fs.mkdtempSync(path.join(testRoot, "install-"));
  const project = path.join(base, "project");
  const temp = path.join(base, "system-temp");
  fs.mkdirSync(project); fs.mkdirSync(temp);
  const env = { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp, PI_CODING_AGENT_DIR: path.join(base, "agent") };
  delete env.PI_TEMP_WORK_ROOT;
  t.after(() => {
    assert.ok(inside(testRoot, base) && base !== testRoot);
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { base, project, temp, env };
}

test("install hook creates Pi-Work with no prior settings or shell profile", t => {
  const f = fixture(t);
  const root = path.join(f.temp, "Pi-Work");
  const hook = path.join(source, "scripts", "postinstall.mjs");
  for (let attempt = 0; attempt < 2; attempt++) {
    const output = execFileSync(process.execPath, [hook], { cwd: f.project, env: f.env, encoding: "utf8", windowsHide: true });
    assert.match(output, /Pi-Work ready:/);
    assert.equal(fs.statSync(root).isDirectory(), true);
    assert.deepEqual(fs.readdirSync(root), []);
    assert.deepEqual(fs.readdirSync(f.project), []);
  }
});

test("npm's actual production install runs the hook without fetching host SDKs", { skip: !process.env.npm_execpath ? "Run via npm test" : !fs.existsSync(path.join(source, "package-lock.json")) ? "Requires the standalone package lockfile" : false }, t => {
  const f = fixture(t);
  const pkg = path.join(f.base, "package");
  fs.mkdirSync(path.join(pkg, "scripts"), { recursive: true });
  for (const file of ["package.json", "package-lock.json", "manager.mjs", "scripts/postinstall.mjs"]) {
    fs.copyFileSync(path.join(source, file), path.join(pkg, file));
  }
  const root = path.join(f.base, "custom-Pi-Work");
  const output = execFileSync(process.execPath, [process.env.npm_execpath, "install", "--omit=dev", "--legacy-peer-deps", "--offline", "--no-audit", "--no-fund"], {
    cwd: pkg, env: { ...f.env, PI_TEMP_WORK_ROOT: root, npm_config_cache: path.join(f.base, "npm-cache"), npm_config_ignore_scripts: "false" },
    encoding: "utf8", windowsHide: true,
  });
  assert.match(output, /Pi-Work ready:/);
  assert.equal(fs.statSync(root).isDirectory(), true);
  assert.equal(fs.existsSync(path.join(pkg, "node_modules", "@earendil-works")), false);
});
