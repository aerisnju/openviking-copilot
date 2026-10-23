import { readdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export async function assertNoInterruptedInstallArtifacts(targets) {
  for (const target of targets) {
    const directory = dirname(target);
    let entries;
    try {
      entries = await readdir(directory);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const ownedArtifact = new RegExp(
      `^${basename(target).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(?:staging|backup)-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$`,
      "i",
    );
    const interrupted = entries.find((entry) => ownedArtifact.test(entry));
    if (interrupted) {
      throw new Error(
        `Refusing to modify an interrupted installation artifact: ${resolve(directory, interrupted)}; preserve it for manual recovery`,
      );
    }
  }
}
