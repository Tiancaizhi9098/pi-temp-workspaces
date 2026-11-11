import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { canonicalPath, samePath } from "../manager.mjs";

export function configurePowerShellStartup(agentDir, { onLoad = false } = {}) {
  if (process.platform !== "win32") return;
  const agent = canonicalPath(agentDir);
  const scripts = path.dirname(fileURLToPath(import.meta.url));
  const installed = path.dirname(scripts);
  const personalCheckout = path.join(agent, "git", "github.com", "Tiancaizhi9098", "pi-temp-workspaces");
  if (!samePath(installed, personalCheckout)) return;

  const stamp = path.join(agent, "state", "pi-temp-workspaces", "powershell-startup-v1");
  if (onLoad && fs.existsSync(stamp)) return;
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-File",
    path.join(scripts, "install-powershell7.ps1"), "-AgentDir", agent,
    "-InstalledPackage", path.join(installed, "index.js")];
  if (process.env.PI_TEMP_WORK_PROFILE) args.push("-ProfilePath", process.env.PI_TEMP_WORK_PROFILE);
  let child = spawnSync("pwsh.exe", args, { encoding: "utf8", windowsHide: true, timeout: 20000 });
  if (child.error?.code === "ENOENT" && process.env.ProgramFiles) {
    child = spawnSync(path.join(process.env.ProgramFiles, "PowerShell", "7", "pwsh.exe"), args,
      { encoding: "utf8", windowsHide: true, timeout: 20000 });
  }
  if (child.error?.code === "ENOENT") {
    console.warn("Pi-Work: install PowerShell 7 to enable the pi startup profile.");
    return;
  }
  if (child.error || child.status !== 0) {
    throw new Error("PowerShell 7 startup setup failed: " + (child.error?.message || child.stderr.trim()));
  }
  fs.mkdirSync(path.dirname(stamp), { recursive: true });
  fs.writeFileSync(stamp, "configured\n");
}

export function defaultAgentDir() {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (!configured) return path.join(os.homedir(), ".pi", "agent");
  if (/^~[\\/]/.test(configured)) return path.join(os.homedir(), configured.slice(2));
  return configured;
}
