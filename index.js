import * as sdk from "@earendil-works/pi-coding-agent";
import { registerTempWorkspaces } from "./extension.mjs";
import { configurePowerShellStartup } from "./scripts/powershell-startup.mjs";

export default function (pi) {
  try {
    configurePowerShellStartup(sdk.getAgentDir(), { onLoad: true });
  } catch (error) {
    pi.on("session_start", (_event, ctx) => ctx.ui.notify(error.message, "warning"));
  }
  registerTempWorkspaces(pi, sdk, { background: process.env.PI_TEMP_WORK_BACKGROUND !== "0" });
}
