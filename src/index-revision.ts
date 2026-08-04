/**
 * `schemaVersion` describes the readable JSON shape. `CODEXA_INDEX_REVISION`
 * describes the derivation semantics used to produce an otherwise compatible
 * schema-v1 index. Legacy schema-v1 bundles omit this revision and remain
 * readable, but freshness must force a rebuild before they are treated as
 * current evidence.
 */
export const CODEXA_INDEX_SCHEMA_VERSION = 1 as const;
export const CODEXA_INDEX_REVISION = 3 as const;
