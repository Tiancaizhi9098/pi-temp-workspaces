import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { canonicalPath } from "../manager.mjs";

const configured = process.env.PI_TEMP_WORK_ROOT;
if (configured && !path.isAbsolute(configured)) throw new Error("PI_TEMP_WORK_ROOT must be an absolute path.");
const root = canonicalPath(configured || path.join(os.tmpdir(), "Pi-Work"));
fs.mkdirSync(root, { recursive: true });
if (!fs.lstatSync(root).isDirectory()) throw new Error(`Pi-Work is not a directory: ${root}`);
console.log(`Pi-Work ready: ${root}`);
