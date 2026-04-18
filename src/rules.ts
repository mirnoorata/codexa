import type { LanguageId } from "./types.js";

export interface CodePatternRule {
  id: string;
  reason: string;
  score: number;
  pattern: RegExp;
  languages?: LanguageId[];
  path?: RegExp;
}

export const CODE_PATTERN_RULES: CodePatternRule[] = [
  {
    id: "shell-execution-boundary",
    reason: "exec/spawn/subprocess call crosses a shell or process boundary",
    score: 2.5,
    pattern: /\b(execFileSync|execFile|spawn|spawnSync|execSync|subprocess\.(run|Popen|call|check_call|check_output))\s*\(/,
    languages: ["typescript", "javascript", "python"]
  },
  {
    id: "filesystem-write-boundary",
    reason: "file write/remove/rename operation can change generated or source artifacts",
    score: 2,
    pattern: /\b(writeFile|appendFile|rename|rm|unlink|mkdir|open)\s*\(|\bfs\.(writeFile|appendFile|rename|rm|unlink|mkdir)\b/,
    languages: ["typescript", "javascript", "python"]
  },
  {
    id: "mcp-tool-surface",
    reason: "MCP tool registration changes agent-visible behavior and annotations",
    score: 2,
    pattern: /\bregisterTool\s*\(/,
    languages: ["typescript", "javascript"],
    path: /(^|\/)mcp\.[cm]?[jt]s$/
  },
  {
    id: "dangerous-html-sink",
    reason: "raw HTML sink requires source and escaping review",
    score: 2,
    pattern: /\bdangerouslySetInnerHTML\b/,
    languages: ["typescript", "javascript"]
  },
  {
    id: "sql-execution-boundary",
    reason: "SQL execution boundary requires parameterization and migration review",
    score: 2,
    pattern: /\.(execute|executemany|executescript|raw)\s*\(/,
    languages: ["typescript", "javascript", "python"]
  },
  {
    id: "fastapi-dependency-boundary",
    reason: "FastAPI dependency injection or router registration can hide runtime wiring from direct calls",
    score: 1.5,
    pattern: /\b(APIRouter|FastAPI|Depends|include_router)\b/,
    languages: ["python"]
  },
  {
    id: "pydantic-model-boundary",
    reason: "Pydantic model schema changes can affect API serialization and validation",
    score: 1.5,
    pattern: /\b(BaseModel|Field|model_validate|model_dump)\b/,
    languages: ["python"]
  },
  {
    id: "sqlalchemy-model-boundary",
    reason: "SQLAlchemy model/session changes can affect persistence, migrations, and query behavior",
    score: 1.5,
    pattern: /\b(SQLAlchemy|declarative_base|relationship|mapped_column|Session|select)\b/,
    languages: ["python"]
  },
  {
    id: "celery-job-boundary",
    reason: "Celery/RQ/task registration can affect background execution paths",
    score: 1.5,
    pattern: /\b(celery|Celery|shared_task|@task|@job|rq\.|enqueue)\b/,
    languages: ["python"]
  },
  {
    id: "queue-lifecycle-boundary",
    reason: "Queue/run lifecycle changes must preserve polling, recovery, cancellation, and terminal-state semantics",
    score: 2,
    pattern: /\b(run_id|queue|polling|queued|running|completed|failed|cancelled|recover|terminal)\b/i,
    languages: ["typescript", "javascript", "python"],
    path: /(^|\/)(api|backend|server|service|src|web\/src|tests)\//
  },
  {
    id: "generator-node-invariant",
    reason: "Generator nodes should preserve shared template, run/lock, prompt-builder, and runtime identity behavior",
    score: 2,
    pattern: /\b(generator|runtime_identity|managed_output|prompt_builder|run_status|generator-node-template)\b/i,
    languages: ["typescript", "javascript", "json"],
    path: /(^|\/)(src|web\/src|packages?|manifests?)\//
  },
  {
    id: "manifest-adapter-contract",
    reason: "Manifest adapter keys must stay aligned with runtime adapter registration and tests",
    score: 2,
    pattern: /\b(type_id|adapter_key|inputs|outputs|managed_output|node_type)\b/i,
    languages: ["json", "python", "typescript", "javascript"],
    path: /(^|\/)(packages?|manifests?|adapters?|src|web\/src)\//
  },
  {
    id: "frontend-polling-boundary",
    reason: "Frontend polling changes can affect queue visibility, silent error surfacing, and run state hydration",
    score: 1.8,
    pattern: /\b(useRunPolling|pollInterval|setInterval|refetch|queue|runStatus|last_error|silent)\b/,
    languages: ["typescript", "javascript"],
    path: /(^|\/)web\/src\//
  },
  {
    id: "release-service-boundary",
    reason: "Release/service control changes can affect live symlinks, staged releases, service managers, or off-port verification",
    score: 2,
    pattern: /\b(release|promote|rollback|systemctl|app\.service|RUN_COORDINATOR_ENABLED|BACKGROUND_INGEST_ENABLED)\b/,
    languages: ["typescript", "javascript", "python"],
    path: /(^|\/)(scripts|api|backend|server|service|src|web\/src)\//
  }
];
