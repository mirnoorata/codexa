import path from "node:path";
import { isTestPath } from "../language.js";
import { detectPlaceholderRisks } from "../placeholder-signals.js";
import type { ParseResult, RiskSignalFact, SymbolFact, UsageSiteFact } from "../types.js";
import { stableId } from "../util.js";
import type { ParseFileInput } from "./context.js";

interface JsonManifestRecord extends Record<string, unknown> {
  scripts?: Record<string, string>;
  nodes?: unknown;
  namespace?: string;
  name?: string;
  compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
  references?: Array<{ path?: unknown }>;
  extends?: unknown;
}

export function parseJsonManifest(input: ParseFileInput, sourceText: string, empty: ParseResult): ParseResult {
  const basename = path.posix.basename(input.relativePath);
  const isNodePackageManifest = isPlausibleNodeManifestPath(input.relativePath);
  const placeholderRisks = detectPlaceholderRisks({
    path: input.relativePath,
    language: "json",
    sourceText,
    snapshotId: input.snapshotId,
    indexedAt: input.indexedAt,
    test: isTestPath(input.relativePath)
  });
  try {
    const parsed = JSON.parse(sourceText) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ...empty, risks: placeholderRisks };
    }
    const record = parsed as JsonManifestRecord;
    if (basename !== "package.json" && basename !== "tsconfig.json" && !isNodePackageManifest) {
      return { ...empty, risks: placeholderRisks };
    }
    const symbols: SymbolFact[] = [];
    const usageSites: UsageSiteFact[] = [];
    const risks: RiskSignalFact[] = [...placeholderRisks];
    const snapshotId = input.snapshotId;
    const indexedAt = input.indexedAt;
    if (basename === "package.json" && record.scripts && typeof record.scripts === "object") {
      for (const [name, command] of Object.entries(record.scripts)) {
        const id = stableId("manifest-script", input.relativePath, name);
        symbols.push({
          id,
          type: "Symbol",
          path: input.relativePath,
          source: "manifest",
          confidence: "authoritative",
          snapshotId,
          indexedAt,
          name,
          qualifiedName: `npm script ${name}`,
          kind: "variable",
          language: "json",
          exported: false,
          decorators: []
        });
        usageSites.push({
          id: stableId("manifest-usage", input.relativePath, name),
          type: "UsageSite",
          path: input.relativePath,
          source: "manifest",
          confidence: "authoritative",
          snapshotId,
          indexedAt,
          name: `npm script ${name}`,
          kind: "reference",
          text: String(command).slice(0, 240)
        });
        if (name.includes("test")) {
          risks.push({
            id: stableId("manifest-risk", input.relativePath, name),
            type: "RiskSignal",
            path: input.relativePath,
            source: "manifest",
            confidence: "authoritative",
            snapshotId,
            indexedAt,
            signal: "test-command",
            score: 0.5,
            reason: `${name}: ${command}`
          });
        }
      }
    }
    if (basename === "tsconfig.json") {
      const projectName = input.relativePath === "tsconfig.json" ? "root" : path.posix.dirname(input.relativePath);
      symbols.push({
        id: stableId("tsconfig-project", input.relativePath, projectName),
        type: "Symbol",
        path: input.relativePath,
        source: "manifest",
        confidence: "authoritative",
        snapshotId,
        indexedAt,
        name: projectName,
        qualifiedName: `typescript project ${projectName}`,
        kind: "module",
        language: "json",
        exported: false,
        decorators: []
      });
      const compilerOptions = record.compilerOptions ?? {};
      if (compilerOptions.baseUrl || (compilerOptions.paths && Object.keys(compilerOptions.paths).length > 0)) {
        usageSites.push({
          id: stableId("tsconfig-baseurl", input.relativePath, compilerOptions.baseUrl ?? "."),
          type: "UsageSite",
          path: input.relativePath,
          source: "manifest",
          confidence: "authoritative",
          snapshotId,
          indexedAt,
          name: compilerOptions.baseUrl ? `baseUrl ${compilerOptions.baseUrl}` : "baseUrl .",
          kind: "reference",
          text: `baseUrl ${compilerOptions.baseUrl ?? "."}`
        });
      }
      const pathEntries = Object.entries(compilerOptions.paths ?? {}) as Array<[string, string[]]>;
      for (const [alias, targets] of pathEntries) {
        const target = targets[0];
        if (!target) {
          continue;
        }
        usageSites.push({
          id: stableId("tsconfig-path-alias", input.relativePath, alias, target),
          type: "UsageSite",
          path: input.relativePath,
          source: "manifest",
          confidence: "authoritative",
          snapshotId,
          indexedAt,
          name: alias,
          kind: "reference",
          text: `path alias ${alias} -> ${target}`
        });
      }
      for (const reference of record.references ?? []) {
        if (typeof reference.path !== "string" || !reference.path.trim()) {
          continue;
        }
        usageSites.push({
          id: stableId("tsconfig-project-reference", input.relativePath, reference.path),
          type: "UsageSite",
          path: input.relativePath,
          source: "manifest",
          confidence: "authoritative",
          snapshotId,
          indexedAt,
          name: reference.path,
          kind: "reference",
          text: `project reference ${reference.path}`
        });
        risks.push({
          id: stableId("tsconfig-project-reference-risk", input.relativePath, reference.path),
          type: "RiskSignal",
          path: input.relativePath,
          source: "manifest",
          confidence: "authoritative",
          snapshotId,
          indexedAt,
          signal: "typescript-project-reference",
          score: 1.5,
          reason: `project reference ${reference.path}`
        });
      }
      if (typeof record.extends === "string" && record.extends.trim()) {
        usageSites.push({
          id: stableId("tsconfig-extends", input.relativePath, record.extends),
          type: "UsageSite",
          path: input.relativePath,
          source: "manifest",
          confidence: "authoritative",
          snapshotId,
          indexedAt,
          name: record.extends,
          kind: "reference",
          text: `extends ${record.extends}`
        });
      }
    }
    const nodeManifestNodes = isNodePackageManifest ? validNodeManifestNodes(record.nodes) : [];
    if (nodeManifestNodes.length > 0) {
      for (const node of nodeManifestNodes) {
        const typeId = node.type_id;
        const title = typeof node.title === "string" ? node.title : typeId;
        const adapterKey = typeof node.adapter_key === "string" ? node.adapter_key : "";
        const id = stableId("node-manifest", input.relativePath, typeId);
        symbols.push({
          id,
          type: "Symbol",
          path: input.relativePath,
          source: "manifest",
          confidence: "authoritative",
          snapshotId,
          indexedAt,
          name: typeId,
          qualifiedName: `node ${typeId}`,
          kind: "node",
          language: "json",
          exported: true,
          decorators: []
        });
        usageSites.push({
          id: stableId("node-manifest-usage", input.relativePath, typeId),
          type: "UsageSite",
          path: input.relativePath,
          source: "manifest",
          confidence: "authoritative",
          snapshotId,
          indexedAt,
          name: typeId,
          kind: "reference",
          text: `${title}${adapterKey ? ` adapter ${adapterKey}` : ""}`.slice(0, 240)
        });
        if (adapterKey) {
          usageSites.push({
            id: stableId("node-manifest-adapter-usage", input.relativePath, typeId, adapterKey),
            type: "UsageSite",
            path: input.relativePath,
            source: "manifest",
            confidence: "derived",
            snapshotId,
            indexedAt,
            name: adapterKey,
            kind: "reference",
            text: `adapter_key ${adapterKey}`
          });
        }
        for (const manifestValue of nodeManifestReferenceValues(node)) {
          usageSites.push({
            id: stableId("node-manifest-field-usage", input.relativePath, typeId, manifestValue),
            type: "UsageSite",
            path: input.relativePath,
            source: "manifest",
            confidence: "heuristic",
            snapshotId,
            indexedAt,
            name: manifestValue,
            kind: "reference",
            text: manifestValue.slice(0, 240)
          });
        }
        risks.push({
          id: stableId("node-manifest-risk", input.relativePath, typeId),
          type: "RiskSignal",
          path: input.relativePath,
          source: "manifest",
          confidence: "authoritative",
          snapshotId,
          indexedAt,
          signal: "node-manifest",
          score: 1.5,
          reason: typeId
        });
      }
    }
    return { ...empty, symbols, usageSites, risks };
  } catch (error) {
    return {
      ...empty,
      risks: placeholderRisks,
      parserErrors: [
        {
          id: stableId("json-parser-error", input.relativePath, String(error)),
          type: "ParserError",
          path: input.relativePath,
          source: "manifest",
          confidence: "heuristic",
          snapshotId: input.snapshotId,
          indexedAt: input.indexedAt,
          message: error instanceof Error ? error.message : String(error)
        }
      ]
    };
  }
}

function isPlausibleNodeManifestPath(filePath: string): boolean {
  if (!/\.json$/iu.test(filePath)) {
    return false;
  }
  const parts = filePath.split("/").filter(Boolean);
  const basename = parts.at(-1) ?? "";
  if (basename === "tsconfig.json") {
    return false;
  }
  const hasManifestLayout = parts.some((part) => /^manifests?$/iu.test(part));
  if (hasManifestLayout) {
    return true;
  }
  const packageIndex = parts.findIndex((part) => /^packages?$/iu.test(part));
  if (packageIndex < 0) {
    return false;
  }
  if (basename === "package.json") {
    return parts.length > packageIndex + 2;
  }
  return /^(?:[^./][^/]*)\.[^.\/]+\.json$/iu.test(basename);
}

function validNodeManifestNodes(nodes: unknown): Array<Record<string, unknown> & { type_id: string }> {
  if (!Array.isArray(nodes)) {
    return [];
  }
  return nodes.filter((node): node is Record<string, unknown> & { type_id: string } => typeof node === "object" && node !== null && typeof (node as { type_id?: unknown }).type_id === "string");
}

function nodeManifestReferenceValues(node: Record<string, unknown>): string[] {
  const values = new Set<string>();
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      if (/\b[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*){1,}\b/.test(value)) {
        values.add(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value && typeof value === "object") {
      for (const child of Object.values(value as Record<string, unknown>)) {
        visit(child);
      }
    }
  };
  visit(node);
  return [...values].sort();
}
