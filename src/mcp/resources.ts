import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isManagedArtifactSegment, readManagedArtifactText, requireManagedArtifactDirectory } from "../managed-artifacts.js";
import { statusQuery } from "../queries.js";
import { loadSkillHints, renderSkillHintsResource } from "../skill-hints.js";
import { mapLimit } from "../util.js";
import {
  readMcpResultArtifact,
  requireMcpResultArtifactId,
  requireMcpResultArtifactRepoLocator,
  type McpResultArtifactRouter
} from "./result-artifacts.js";

const MCP_ARTIFACT_LIST_LIMIT = 80;
const MCP_ARTIFACT_LIST_CANDIDATE_LIMIT = 512;

export interface McpDetailedResultReadEvent {
  repoRoot?: string;
  uri: string;
  outcome: "ok" | "error";
  text?: string;
  response?: { contents: Array<{ uri: string; mimeType: string; text: string }> };
  elapsedMs: number;
}

export async function registerArtifactResources(
  server: McpServer,
  resolveRepoRoot: () => Promise<string>,
  resolveReadyRepoRoot: () => Promise<string> = resolveRepoRoot,
  resultRouter?: McpResultArtifactRouter,
  onDetailedResultRead?: (event: McpDetailedResultReadEvent) => void
): Promise<void> {
  const artifacts = [
    ["codebase-readme", "codexa://repo/codebase/README.md", ".codex/codebase/README.md", "text/markdown", "Codexa artifact overview"],
    ["codex-contract", "codexa://repo/codebase/codex-contract.md", ".codex/codebase/codex-contract.md", "text/markdown", "Codex automatic-use contract"],
    ["repo-map", "codexa://repo/codebase/repo-map.md", ".codex/codebase/repo-map.md", "text/markdown", "Ranked repository map"],
    ["risk-map", "codexa://repo/codebase/risk-map.md", ".codex/codebase/risk-map.md", "text/markdown", "Risk-ranked files and signals"],
    ["placeholder-map", "codexa://repo/codebase/placeholder-map.md", ".codex/codebase/placeholder-map.md", "text/markdown", "Placeholder and dummy code/data signals"],
    ["test-map", "codexa://repo/codebase/test-map.md", ".codex/codebase/test-map.md", "text/markdown", "Detected test files and test edges"],
    ["conventions", "codexa://repo/codebase/conventions.md", ".codex/codebase/conventions.md", "text/markdown", "Detected project conventions"],
    ["workflows", "codexa://repo/codebase/workflows.md", ".codex/codebase/workflows.md", "text/markdown", "Detected workflow traces"],
    ["playbooks", "codexa://repo/codebase/playbooks/README.md", ".codex/codebase/playbooks/README.md", "text/markdown", "Generated Codexa change playbook index"],
    ["skill-hints", "codexa://repo/codebase/skill-hints.md", ".codex/skill-hints.json", "text/markdown", "Configured skill roots and path-matched skill hints"],
    ["freshness-json", "codexa://repo/codebase/freshness.json", ".codex/codebase/freshness.json", "application/json", "Codexa freshness snapshot"]
  ] as const;

  for (const [name, uri, relativePath, mimeType, description] of artifacts) {
    server.registerResource(
      name,
      uri,
      {
        title: `Codexa ${name}`,
        description,
        mimeType
      },
      async () => ({
        contents: [
          {
            uri,
            mimeType,
            text:
              relativePath === ".codex/codebase/freshness.json"
                ? await readLiveFreshnessArtifact(await resolveRepoRoot())
                : relativePath === ".codex/skill-hints.json"
                  ? renderSkillHintsResource(await loadSkillHints(await resolveRepoRoot()))
                : await readArtifact(await resolveReadyRepoRoot(), relativePath)
          }
        ]
      })
    );
  }

  server.registerResource(
    "module-index",
    "codexa://repo/codebase/modules",
    {
      title: "Codexa module index",
      description: "List generated Codexa module artifact names.",
      mimeType: "text/markdown"
    },
    async () => {
      const repoRoot = await resolveReadyRepoRoot();
      let text = "# Codexa Modules\n\n";
      try {
        const modules = await requireManagedArtifactDirectory(repoRoot, path.join(repoRoot, ".codex", "codebase", "modules"));
        const listed = await regularSingleLinkMarkdownNames(modules.directory);
        const names = listed.names.slice(0, MCP_ARTIFACT_LIST_LIMIT);
        text += names.map((name) => `- codexa://repo/codebase/modules/${encodeURIComponent(name)}`).join("\n") || "- none";
        const omitted = listed.names.length - names.length + listed.omittedCandidates;
        if (omitted > 0) {
          text += `\n- ... ${omitted} more module candidates omitted from this bounded index`;
        }
      } catch {
        text += "- modules unavailable; run `codexa index <repo>` first";
      }
      return { contents: [{ uri: "codexa://repo/codebase/modules", mimeType: "text/markdown", text }] };
    }
  );

  server.registerResource(
    "module-artifact",
    new ResourceTemplate("codexa://repo/codebase/modules/{name}", {
      list: async () => ({
        resources: await listMarkdownArtifacts(await resolveReadyRepoRoot(), ".codex/codebase/modules", "codexa://repo/codebase/modules", "Codexa module", "Generated Codexa module artifact")
      })
    }),
    {
      title: "Codexa module artifact",
      description: "Read a generated Codexa module artifact by filename.",
      mimeType: "text/markdown"
    },
    async (uri, variables) => {
      const name = artifactNameVariable(variables.name);
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "text/markdown",
            text: await readArtifact(await resolveReadyRepoRoot(), `.codex/codebase/modules/${name}`)
          }
        ]
      };
    }
  );

  server.registerResource(
    "playbook-artifact",
    new ResourceTemplate("codexa://repo/codebase/playbooks/{name}", {
      list: async () => ({
        resources: await listMarkdownArtifacts(
          await resolveReadyRepoRoot(),
          ".codex/codebase/playbooks",
          "codexa://repo/codebase/playbooks",
          "Codexa playbook",
          "Generated Codexa change playbook",
          (name) => name !== "README.md"
        )
      })
    }),
    {
      title: "Codexa playbook artifact",
      description: "Read a generated Codexa change playbook by filename.",
      mimeType: "text/markdown"
    },
    async (uri, variables) => {
      const name = artifactNameVariable(variables.name);
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "text/markdown",
            text: await readArtifact(await resolveReadyRepoRoot(), `.codex/codebase/playbooks/${name}`)
          }
        ]
      };
    }
  );

  server.registerResource(
    "mcp-detailed-result",
    new ResourceTemplate("codexa://repo/mcp-results/{repo}/{id}", { list: undefined }),
    {
      title: "Codexa detailed MCP result",
      description: "Read an exact, content-addressed detailed result referenced by a concise MCP receipt.",
      mimeType: "application/json"
    },
    async (uri, variables) => {
      const id = singleResourceVariable(variables.id);
      const repo = singleResourceVariable(variables.repo);
      requireMcpResultArtifactId(id);
      requireMcpResultArtifactRepoLocator(repo);
      const routedRoot = resultRouter?.resolve(repo);
      if (!routedRoot) throw new Error("Codexa detailed-result route is not available in this MCP server session");
      return readDetailedResultResource(uri.toString(), routedRoot, id, onDetailedResultRead);
    }
  );

}

async function readDetailedResultResource(
  uri: string,
  repoRoot: string,
  id: string,
  onRead?: (event: McpDetailedResultReadEvent) => void
): Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }> {
  if (!onRead) {
    const text = await readMcpResultArtifact(repoRoot, id);
    return { contents: [{ uri, mimeType: "application/json", text }] };
  }
  const startedAt = performance.now();
  try {
    const text = await readMcpResultArtifact(repoRoot, id);
    const response = { contents: [{ uri, mimeType: "application/json", text }] };
    emitDetailedResultRead(onRead, {
      repoRoot,
      uri,
      outcome: "ok",
      text,
      response,
      elapsedMs: Math.max(0, Math.round((performance.now() - startedAt) * 1000) / 1000)
    });
    return response;
  } catch (error) {
    emitDetailedResultRead(onRead, {
      repoRoot,
      uri,
      outcome: "error",
      elapsedMs: startedAt > 0 ? Math.max(0, Math.round((performance.now() - startedAt) * 1000) / 1000) : 0
    });
    throw error;
  }
}

function emitDetailedResultRead(callback: ((event: McpDetailedResultReadEvent) => void) | undefined, event: McpDetailedResultReadEvent): void {
  if (!callback) return;
  try {
    callback(event);
  } catch (error) {
    console.error(`Codexa MCP resource telemetry event dropped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readArtifact(repoRoot: string, relativePath: string): Promise<string> {
  try {
    return await readManagedArtifactText(repoRoot, relativePath.split("/"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Codexa artifact missing: ${relativePath}. Run: codexa index ${repoRoot}. ${message}`);
  }
}

async function readLiveFreshnessArtifact(repoRoot: string): Promise<string> {
  const status = await statusQuery(repoRoot, { recover: false });
  return `${JSON.stringify(status.data, null, 2)}\n`;
}

async function listMarkdownArtifacts(
  repoRoot: string,
  relativeDir: string,
  uriPrefix: string,
  titlePrefix: string,
  descriptionPrefix: string,
  include: (name: string) => boolean = () => true
) {
  try {
    const directory = await requireManagedArtifactDirectory(repoRoot, path.join(repoRoot, ...relativeDir.split("/")));
    const listed = await regularSingleLinkMarkdownNames(directory.directory, include);
    return listed.names.slice(0, MCP_ARTIFACT_LIST_LIMIT).map((name) => ({
      name: `${titlePrefix} ${name}`,
      uri: `${uriPrefix}/${encodeURIComponent(name)}`,
      title: `${titlePrefix} ${name}`,
      description: `${descriptionPrefix} ${name}`,
      mimeType: "text/markdown"
    }));
  } catch {
    return [];
  }
}

async function regularSingleLinkMarkdownNames(
  directory: string,
  include: (name: string) => boolean = () => true
): Promise<{ names: string[]; omittedCandidates: number }> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const candidates = entries
    .filter(
      (entry) =>
        isManagedArtifactSegment(entry.name) &&
        entry.name.endsWith(".md") &&
        include(entry.name)
    )
    .map((entry) => entry.name)
    .sort();
  const inspected = candidates.slice(0, MCP_ARTIFACT_LIST_CANDIDATE_LIMIT);
  const names = await mapLimit(inspected, 16, async (name) => {
    const artifact = await fs.lstat(path.join(directory, name)).catch(() => undefined);
    return artifact?.isFile() && !artifact.isSymbolicLink() && artifact.nlink === 1
      ? name
      : undefined;
  });
  return {
    names: names.filter((name): name is string => Boolean(name)),
    omittedCandidates: Math.max(0, candidates.length - inspected.length)
  };
}

function artifactNameVariable(value: string | string[]): string {
  const name = Array.isArray(value) ? value.join("/") : value;
  if (!isManagedArtifactSegment(name) || !name.endsWith(".md")) {
    throw new Error(`Invalid Codexa artifact name: ${name}`);
  }
  return name;
}

function singleResourceVariable(value: string | string[]): string {
  const resolved = Array.isArray(value) ? value.join("/") : value;
  if (!resolved || resolved.includes("/") || resolved.includes("\\") || resolved === "." || resolved === "..") {
    throw new Error(`Invalid Codexa resource variable: ${resolved}`);
  }
  return resolved;
}
