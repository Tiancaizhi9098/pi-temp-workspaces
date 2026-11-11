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
  for (const file of ["package.json", "package-lock.json", "manager.mjs", "scripts/postinstall.mjs", "scripts/powershell-startup.mjs"]) {
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

test("personal Git install makes plain pi start the real CLI in Pi-Work before extensions load", { skip: process.platform !== "win32", timeout: 30000 }, t => {
  const f = fixture(t);
  const checkout = path.join(f.env.PI_CODING_AGENT_DIR, "git/github.com/Tiancaizhi9098/pi-temp-workspaces");
  fs.mkdirSync(checkout, { recursive: true });
  fs.cpSync(path.join(source, "scripts"), path.join(checkout, "scripts"), { recursive: true });
  for (const file of ["manager.mjs", "index.js"]) fs.copyFileSync(path.join(source, file), path.join(checkout, file));
  const profile = path.join(f.base, "PowerShell/profile.ps1");
  const log = path.join(f.base, "entry.jsonl");
  const probe = path.join(f.base, "observe.cjs");
  const sdkDist = path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  const binDir = path.resolve(sdkDist, "../../../.bin");
  assert.ok(fs.existsSync(path.join(binDir, "pi.ps1")));
  // Observe the real CLI entry before Pi can apply a session or tool cwd.
  fs.writeFileSync(probe, `if (/[\\\\/]cli\\.js$/.test(process.argv[1] || '')) { require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd:process.cwd(), args:process.argv.slice(2) })+'\\n'); process.exit(0); }`);
  const env = { ...f.env, PI_TEMP_WORK_PROFILE: profile };
  const hook = path.join(checkout, "scripts/postinstall.mjs");
  execFileSync(process.execPath, [hook], { cwd: checkout, env, windowsHide: true });
  const run = path.join(f.base, "run.ps1");
  fs.writeFileSync(run, [
    "$ErrorActionPreference = 'Stop'", ". $env:PI_TEMP_WORK_PROFILE",
    "if ((Get-Command pi).CommandType -ne 'Function') { throw 'Startup function was not loaded' }",
    "Set-Location ~", "pi", "pi install ./local-package",
    "Set-Location -LiteralPath $env:PI_FIXTURE_PROJECT", "pi",
    "Set-Location -LiteralPath ([IO.Path]::GetPathRoot($env:PI_FIXTURE_PROJECT))", "pi",
  ].join("\n"));
  const pwsh = process.env.PI_TEST_PWSH || "pwsh.exe";
  const invoke = () => execFileSync(pwsh, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", run], {
    env: { ...env, PATH: binDir + path.delimiter + process.env.PATH, PI_FIXTURE_PROJECT: f.project, NODE_OPTIONS: '--require="' + probe.split(path.sep).join("/") + '"' }, windowsHide: true
  });
  invoke();
  const rows = fs.readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const root = path.join(f.temp, "Pi-Work");
  assert.deepEqual(rows.map(row => row.cwd.toLowerCase()), [root, process.env.USERPROFILE, f.project, root].map(p => p.toLowerCase()));
  assert.deepEqual(rows.map(row => row.args), [[], ["install", "./local-package"], [], []]);
});
