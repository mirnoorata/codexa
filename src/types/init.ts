import type { PolicyPackInitResult } from "../policy-pack.js";

export type InitToolProfile = "core" | "full";

export interface InitOptions {
  autoRefresh?: boolean;
  cliPath: string;
  hooks?: boolean;
  index?: boolean;
  serverName?: string;
  toolProfile?: InitToolProfile;
  agentsMd?: boolean;
  claudeMd?: boolean;
  claude?: boolean;
  policyPack?: boolean;
  ci?: boolean;
}

export interface InitResult {
  repoRoot: string;
  configPath: string;
  hooksPath: string | null;
  agentsMdPath: string | null;
  claudeMdPath: string | null;
  claudeMcpPath: string | null;
  policyPack: PolicyPackInitResult | null;
  ciWorkflowPath: string | null;
  serverName: string;
  launchNote: string | null;
  indexed: {
    files: number;
    symbols: number;
    usageSites: number;
  } | null;
}
