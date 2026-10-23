import { lstat, rename } from "node:fs/promises";

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function rollbackInstallMoves(moves, renamePath = rename) {
  const rollbackErrors = [];
  for (const move of [...moves].reverse()) {
    try {
      if (await exists(move.to)) await renamePath(move.to, move.from);
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  return rollbackErrors;
}

export async function replaceInstallTargets(replacements, renamePath = rename) {
  const moves = [];
  try {
    for (const replacement of replacements) {
      if (await exists(replacement.target)) {
        await renamePath(replacement.target, replacement.backup);
        moves.push({ from: replacement.target, to: replacement.backup });
      }
      await renamePath(replacement.staged, replacement.target);
      moves.push({ from: replacement.staged, to: replacement.target });
    }
  } catch (error) {
    const rollbackErrors = await rollbackInstallMoves(moves, renamePath);
    if (rollbackErrors.length > 0) {
      const backups = replacements.map(({ backup }) => backup).join(", ");
      throw new AggregateError(
        [error, ...rollbackErrors],
        `Installation failed and rollback was incomplete; preserve the backup paths ${backups}`,
      );
    }
    throw error;
  }
}
