import { discoverRepoFiles, type RepoFiles } from "../repo-files.js";

export async function discoverIndexInputs(repoRoot: string): Promise<RepoFiles> {
  return discoverRepoFiles(repoRoot);
}
