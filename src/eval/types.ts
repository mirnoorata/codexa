import type { QueryResult } from "../types.js";

export type EvalSuite = "all" | "project" | "synthetic" | "historical-fixture" | "task-pack";
export type EvalScenarioSuite = Exclude<EvalSuite, "all"> | "historical-task-pack";

export interface EvalScenario {
  id: string;
  suite: EvalScenarioSuite;
  description: string;
  repoRoot: string;
  scored?: boolean;
  baselineCommand?: string[];
  baselineCommands?: string[][];
  baselineCwd?: string;
  codexa: () => Promise<QueryResult>;
  oracle: EvalOracle;
  privatePack?: boolean;
  taskPackPath?: string;
  cleanupRepoRoot?: string;
  cleanupRepoRoots?: string[];
}

export interface EvalOracle {
  expectedFiles?: string[];
  expectedChangedFiles?: string[];
  expectedTests?: string[];
  forbiddenFiles?: string[];
  topFiles?: string[];
  knownTraps?: string[];
  expectedCodexaCalls?: string[];
  maxTextChars?: number;
  maxDataBytes?: number;
  maxFalsePositiveFiles?: number;
  maxTestCount?: number;
  minFileRecall?: number;
  minChangedFileRecall?: number;
  minTestRecall?: number;
  minFilePrecisionAtK?: number;
  maxSelectedToBaselineRatio?: number;
}
