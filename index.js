import * as sdk from "@earendil-works/pi-coding-agent";
import { registerTempWorkspaces } from "./extension.mjs";

export default function (pi) {
  registerTempWorkspaces(pi, sdk, { background: process.env.PI_TEMP_WORK_BACKGROUND !== "0" });
}
