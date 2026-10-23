import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  "probes/extension/extension.mjs",
  "probes/extension/mcp-server.mjs",
  "probes/hooks/hook-recorder.mjs",
  "scripts/install-probes.mjs",
  "scripts/uninstall-probes.mjs",
];

for (const relativePath of files) {
  const source = await readFile(resolve(projectRoot, relativePath), "utf8");
  if (source.includes("console.log(")) {
    throw new Error(`${relativePath} writes to stdout with console.log`);
  }
}

const packageJson = JSON.parse(
  await readFile(resolve(projectRoot, "package.json"), "utf8"),
);
if (packageJson.type !== "module") {
  throw new Error("package.json must use ES modules");
}

process.stdout.write(`${JSON.stringify({ validated: files.length })}\n`);

