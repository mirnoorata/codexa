export function capabilitiesDecisionKernel(data: Record<string, unknown>): Record<string, unknown> {
  const described = isRecord(data.described) ? data.described : undefined;
  if (described) {
    const schema = isRecord(described.schema) ? described.schema : {};
    const requiredInputs = strings(schema.required, 40);
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const nestedRequired = nestedRequiredPaths(schema).filter((entry) => !requiredInputs.includes(entry));
    return defined({
      action: "describe",
      capabilityHash: bounded(data.capabilityHash, 64),
      operationCount: data.operationCount,
      operation: bounded(described.operation, 100),
      schemaHash: bounded(described.schemaHash, 64),
      requiredInputs,
      inputNames: Object.keys(properties).slice(0, 40),
      nestedRequiredPathCount: nestedRequired.length,
      nestedRequiredPaths: nestedRequired.slice(0, 16),
      nestedRequiredPathsOmitted: Math.max(0, nestedRequired.length - 16)
    });
  }
  const operations = Array.isArray(data.operations) ? data.operations.filter(isRecord) : [];
  return defined({
    action: "list",
    capabilityHash: bounded(data.capabilityHash, 64),
    operationCount: typeof data.operationCount === "number" ? data.operationCount : operations.length,
    operations: operations.map((entry) => defined({ name: bounded(entry.name, 100), requiredInputs: strings(entry.requiredInputs, 20) }))
  });
}

export function compactCapabilitiesKernel(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const operations = Array.isArray(value.operations) ? value.operations.filter(isRecord) : [];
  return defined({
    action: bounded(value.action, 20),
    capabilityHash: bounded(value.capabilityHash, 64),
    operationCount: value.operationCount,
    operation: bounded(value.operation, 100),
    schemaHash: bounded(value.schemaHash, 64),
    requiredInputs: strings(value.requiredInputs, 40),
    inputNames: strings(value.inputNames, 40),
    nestedRequiredPathCount: value.nestedRequiredPathCount,
    nestedRequiredPaths: strings(value.nestedRequiredPaths, 16),
    nestedRequiredPathsOmitted: value.nestedRequiredPathsOmitted,
    operations: operations.map((entry) => defined({ name: bounded(entry.name, 100), requiredInputs: strings(entry.requiredInputs, 20) }))
  });
}

export function renderCapabilitiesKernel(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const hash = string(value.schemaHash) ?? string(value.capabilityHash) ?? "unknown";
  if (value.action === "describe") {
    const required = strings(value.requiredInputs, 40);
    const inputs = strings(value.inputNames, 40);
    const nested = strings(value.nestedRequiredPaths, 16);
    return [
      `Capability: ${clip(string(value.operation) ?? "unknown", 100)}; schema ${hash}; required ${required.join(",") || "none"}; inputs ${inputs.join(",") || "none"}`,
      nested.length > 0 ? `Nested required (${typeof value.nestedRequiredPathCount === "number" ? value.nestedRequiredPathCount : nested.length}): ${nested.join(", ")}` : undefined
    ].filter((entry): entry is string => Boolean(entry)).map((entry) => clip(entry, 700));
  }
  const operations = Array.isArray(value.operations) ? value.operations.filter(isRecord) : [];
  return [clip(
    `Capabilities (${typeof value.operationCount === "number" ? value.operationCount : operations.length}; hash ${hash}): ${operations.map((entry) => `${string(entry.name) ?? "unknown"}[${strings(entry.requiredInputs, 20).join(",") || "none"}]`).join(" | ")}`,
    1_200
  )];
}

function nestedRequiredPaths(schema: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const visit = (value: unknown, prefix: string, depth: number): void => {
    if (!isRecord(value) || depth > 8 || paths.length >= 64) return;
    for (const required of strings(value.required, 40)) {
      const requiredPath = prefix ? `${prefix}.${required}` : required;
      if (!paths.includes(requiredPath)) paths.push(requiredPath);
    }
    const properties = isRecord(value.properties) ? value.properties : {};
    for (const [name, child] of Object.entries(properties)) visit(child, prefix ? `${prefix}.${name}` : name, depth + 1);
    if (value.items) visit(value.items, `${prefix}[]`, depth + 1);
  };
  visit(schema, "", 0);
  return paths;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function strings(value: unknown, limit: number): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").slice(0, limit).map((entry) => entry.slice(0, 220)) : [];
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function bounded(value: unknown, limit: number): string | undefined {
  const entry = string(value);
  return entry?.slice(0, limit);
}

function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function defined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && (!Array.isArray(entry) || entry.length > 0) && (!isRecord(entry) || Object.keys(entry).length > 0)));
}
