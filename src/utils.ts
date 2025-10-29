import { SimpleGit } from "simple-git";
import fs from "fs";
import path from "path";

/**
 * Checks if the git remote is pointing to git.coderpass.io
 * @param git - SimpleGit instance
 * @param remote - Remote name to check (default: "origin")
 * @returns true if the remote points to git.coderpass.io, false otherwise
 */
export async function checkRemoteIsCoderPass(
  git: SimpleGit,
  remote: string = "origin"
): Promise<boolean> {
  const remotes = await git.getRemotes(true);
  const originRemote = remotes.find((r) => r.name === remote);
  const remoteUrl = originRemote?.refs?.push || originRemote?.refs?.fetch;

  return remoteUrl?.includes("git.coderpass.io") ?? false;
}

/**
 * Detect CI workflows using git to inspect repository contents (tracked files).
 */
export async function hasCiWorkflow(git: SimpleGit): Promise<boolean> {
  // Check tracked files in the current HEAD or index
  const tracked = await git.raw([
    "ls-files",
    "--",
    ".github/workflows",
    ".gitea/workflows",
  ]);
  return tracked.trim().length > 0;
}
