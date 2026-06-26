# Codexa No-Brainer Install Guide

Current positioning as of 2026-06-26: Codexa should not try to be another IDE,
chat UI, hosted review bot, or generic code search product. Its strongest
wedge is the proof and governance layer around AI coding agents.

## What Codexa should win

Codexa excels when a local agent is about to edit a repository and the user
needs evidence, not confidence theater:

- **Plan proof:** `change-plan --save-snapshot` records the intended scope
  before edits.
- **Drift proof:** `post-edit-review` compares the dirty tree to that saved
  plan, including symbol/risk deltas and planned-test provenance.
- **Verification proof:** reported commands earn credit only through Codexa's
  shared command classifier; masked or non-running commands fail closed.
- **Install proof:** `codexa prove` summarizes freshness, read-first files,
  snapshot status, verification preview, reported command/test evidence,
  local policies, trust posture, and gaps in one packet.
- **Local trust boundary:** core paths are local, deterministic, model-free,
  and query-only over MCP.

This complements adjacent tools instead of competing with all of them. Use
Sourcegraph or Augment for deep enterprise-scale code intelligence, Serena for
symbol-level IDE-style agent actions, Context7 for current library docs,
Greptile or CodeRabbit for hosted PR review, and Aider or Continue for coding
UX. Install Codexa when the missing piece is proof that the agent followed a
plan and verified what it claims.

## Best install path

For Codex CLI:

```bash
npm install -g @mirnoorata/codexa
codexa init /path/to/project --agents-md
codexa policy-init /path/to/project
codexa prove /path/to/project --task "make this change safely"
```

For Claude Code with hooks and slash commands:

```text
/plugin marketplace add <codexa-root>/integrations
/plugin install codexa@codexa-integrations
```

Then in the target repo:

```bash
codexa init /path/to/project --claude-md
codexa policy-init /path/to/project
```

Inside Claude Code, run:

```text
/codexa-prove make this change safely
/codexa-plan "make this change safely" src/file.ts
/codexa-review --ran-command "npm run check"
```

For Claude Code MCP-only mode, skip the plugin and run:

```bash
codexa init /path/to/project --claude
codexa policy-init /path/to/project
```

Use the plugin or `--claude`, not both, so Claude does not register two Codexa
servers.

## Compatibility matrix

| Environment | Fit | Install | Caveat |
| --- | --- | --- | --- |
| Codex CLI | Best | `codexa init <repo>` | Requires local repo and Node 22+. |
| Claude Code | Best with plugin | Claude plugin marketplace under `integrations/` | Plugin adds hooks and `/codexa-prove`; MCP-only mode skips hooks. |
| Cursor, Continue, Gemini CLI, custom MCP clients | Good | MCP registry or `codexa serve <repo>` | Host must run near the local repo. |
| Managed cloud agent containers | Conditional | Self-host tool execution and Codexa together | Codexa does not expose a public remote HTTP server. |
| GitHub-only hosted review | Not the target | Use hosted review tools | Codexa is local proof/context, not a SaaS PR bot. |

## Gaps to keep honest

- Deep parsing is strongest for TypeScript, JavaScript, and Python; other
  languages benefit from shallow facts or imported symbol/risk reports.
- Codexa does not execute arbitrary test suites by default; AutoVerify is
  opt-in and bounded. The proof card previews what would earn credit and
  separately classifies reported verification evidence.
- No cloud team dashboard exists. The durable artifact is local `.codex/`
  evidence and ordinary git history.
- Codexa is not a refactoring engine. It tells an agent what to read, plan,
  and verify; the host or user performs edits.

## Why it becomes a no-brainer

The install is worth it when the user can answer these questions after any
agent session:

- Was the index fresh when the agent planned the work?
- Which files did Codexa tell the agent to read first?
- Was there a saved plan snapshot before edits?
- Did the actual dirty tree stay inside that plan?
- Which commands actually earned verification credit?
- Which proof gaps remain?

`codexa prove` is now the fast path to that answer.
