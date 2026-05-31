import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { QuerySession } from "../query/session.js";
import { statusQuery } from "../queries.js";

export async function registerArtifactResources(server: McpServer, resolveRepoRoot: () => Promise<string>): Promise<void> {
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
                : await readArtifact(await resolveRepoRoot(), relativePath)
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
      const repoRoot = await resolveRepoRoot();
      const modulesDir = path.join(repoRoot, ".codex/codebase/modules");
      let text = "# Codexa Modules\n\n";
      try {
        const allNames = (await fs.readdir(modulesDir)).filter((name) => name.endsWith(".md")).sort();
        const names = allNames.slice(0, 80);
        text += names.map((name) => `- codexa://repo/codebase/modules/${encodeURIComponent(name)}`).join("\n") || "- none";
        if (allNames.length > names.length) {
          text += `\n- ... ${allNames.length - names.length} more modules omitted from this bounded index`;
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
        resources: await listMarkdownArtifacts(await resolveRepoRoot(), ".codex/codebase/modules", "codexa://repo/codebase/modules", "Codexa module", "Generated Codexa module artifact")
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
            text: await readArtifact(await resolveRepoRoot(), `.codex/codebase/modules/${name}`)
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
          await resolveRepoRoot(),
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
            text: await readArtifact(await resolveRepoRoot(), `.codex/codebase/playbooks/${name}`)
          }
        ]
      };
    }
  );
}

export async function notifyResourceListChangedAfterRefresh(server: McpServer, session: QuerySession): Promise<void> {
  if (!session.refresh?.refreshed) {
    return;
  }
  await Promise.resolve(server.sendResourceListChanged());
}

async function readArtifact(repoRoot: string, relativePath: string): Promise<string> {
  try {
    return await fs.readFile(path.join(repoRoot, relativePath), "utf8");
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
    const names = (await fs.readdir(path.join(repoRoot, relativeDir))).filter((name) => name.endsWith(".md") && include(name)).sort().slice(0, 80);
    return names.map((name) => ({
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

function artifactNameVariable(value: string | string[]): string {
  const name = Array.isArray(value) ? value.join("/") : value;
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === ".." || !name.endsWith(".md")) {
    throw new Error(`Invalid Codexa artifact name: ${name}`);
  }
  return name;
}
