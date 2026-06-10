import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version?: unknown };

export const CODEXA_VERSION = typeof packageJson.version === "string" && packageJson.version ? packageJson.version : "0.0.0";
