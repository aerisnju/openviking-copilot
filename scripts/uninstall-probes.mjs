import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

const copilotHome =
  process.env.COPILOT_HOME || resolve(homedir(), ".copilot");
const extensionTarget = resolve(
  copilotHome,
  "extensions",
  "openviking-host-probe",
);
const hookTarget = resolve(
  copilotHome,
  "hooks",
  "openviking-host-probe.json",
);

async function removeOwnedHook() {
  try {
    const hook = JSON.parse(await readFile(hookTarget, "utf8"));
    const entries = Object.values(hook.hooks ?? {}).flat();
    if (
      entries.length === 0 ||
      entries.some(
        (entry) =>
          entry.env?.OPENVIKING_COPILOT_PROBE_OWNER !==
          "openviking-copilot-host-probe",
      )
    ) {
      throw new Error(`Refusing to remove unowned hook file: ${hookTarget}`);
    }
    await rm(hookTarget);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

async function removeOwnedExtension() {
  try {
    const config = JSON.parse(
      await readFile(resolve(extensionTarget, "probe-config.json"), "utf8"),
    );
    if (config.owner !== "openviking-copilot-host-probe") {
      throw new Error(
        `Refusing to remove unowned extension directory: ${extensionTarget}`,
      );
    }
    await rm(extensionTarget, { recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

await removeOwnedHook();
await removeOwnedExtension();
process.stdout.write(
  `${JSON.stringify({ removedExtension: extensionTarget, removedHook: hookTarget })}\n`,
);
