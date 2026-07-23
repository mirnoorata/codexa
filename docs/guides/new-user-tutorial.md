# Codexa New User Tutorial

This tutorial walks through the first successful Codexa setup and edit loop.
It assumes you want Codexa to help an AI coding agent understand a local git
repository without sending source code to a hosted indexing service.

## What you will do

1. Install Codexa.
2. Wire Codexa into one local repository, including optional local policy defaults.
3. Check that the index and MCP server are ready.
4. Use the smallest source, search, plan, edit, and review sequence the task needs.
5. Print a proof card for the final handoff.
6. Know where to look when setup is not ready.

## Before you start

Codexa requires Node.js 22 or newer and a local git checkout:

```bash
node --version
git -C /path/to/project status --short --branch
```

The project path should be the repository you want your agent to work on, not
the Codexa source checkout unless you are developing Codexa itself.

## 1. Install Codexa

Install the published package:

```bash
npm install -g @mirnoorata/codexa
codexa --version
```

Or run from a source checkout:

```bash
git clone https://github.com/mirnoorata/codexa.git
cd codexa
npm install
npm run build
npm link
codexa --version
```

## 2. Wire one repository

For Codex CLI, initialize the target repository:

```bash
codexa init /path/to/project --policy-pack
```

For Claude Code, add `--claude` so Codexa also writes a repo-root `.mcp.json`:

```bash
codexa init /path/to/project --claude --policy-pack
```

`codexa init` writes Codexa MCP configuration and hook files for the target
repo, then builds the first `.codex/codebase/` index. It does not edit your
source files. Generated Codexa artifacts live under `.codex/codebase/` and
`.codex/cache/`.

Fresh managed installs and bare `codexa serve` use the core MCP profile. It advertises only `search`,
`change_plan`, and `capabilities`; the dispatcher keeps every non-core
operation reachable without adding every tool schema to each agent turn. Use
`--tools full` only when direct exposure of the complete tool surface is worth
the larger decoded `tools/list` JSON surface. This is a serialized-byte proxy,
not a measurement of model tokens, provider cost, or provider-specific wire
serialization.

With `--policy-pack`, init also creates `.codex/policies/verification.json`,
`.codex/policies/complexity.json`, and `.codex/policies/security.json`. These
files are plain JSON consumed by `codexa prove`; they are not executable and
Codexa does not overwrite them on later init runs. For an already wired repo,
run `codexa policy-init /path/to/project`; pass `--force` only when you
intentionally want to replace existing policy files.

## 3. Check readiness

After setup, or whenever freshness is in doubt, check readiness with:

```bash
codexa session-start /path/to/project
```

The versioned receipt reports the repo path and current commit, static MCP
configuration and tool profile, index freshness, dirty-file and parser-error
counts, current-thread MCP activation, and the selective-use cadence. Managed
host hooks surface it automatically, so an agent does not need to call this
command at the start of every turn. `fresh` means the stored Codexa index
matches the current checkout. `stale` usually means the checkout changed since
the last index, and most context commands can refresh it automatically.
`Current-thread MCP: unverified` is expected from SessionStart: only the host's
actual MCP initialize handshake can prove that this thread loaded the server.
At a shared workspace root, `routing: selection-required` and `Index:
not-selected` mean only a previous workspace default or unselected active row
was available; select an active row with `--workspace-session <id>` before
loading project context. If a shared coordinator generates a selector file,
use its validator rather than sourcing the mutable file directly.
`metadata-invalid` means stored index identity fields failed bounded validation;
`parser-degraded` means indexing completed with parser errors. Reindex and
inspect the parser failures before treating either state as ready.

For a fuller setup check, run:

```bash
codexa doctor /path/to/project
```

Use `doctor` when the agent cannot see Codexa tools, the MCP server is not
starting, hooks did not run, or freshness looks wrong.

## 4. Use the everyday edit loop

Codexa is most useful when it supplies evidence that direct source inspection
cannot. For an exact, local, low-risk issue, read the named files and run the
repository's checks with zero Codexa calls.

For a non-trivial issue such as "rename this CLI option across docs, parsing,
and generated help", save one plan before editing:

```bash
codexa change-plan /path/to/project \
  --task "rename this CLI option in docs and help text" \
  --file README.md \
  --save-snapshot
```

Because the task already names a bounded target, no separate brief is needed.
When the target is ambiguous, make one `search` call and stop discovery if its
raw results are sufficient. A materially risky edit may still warrant one
`change-plan` after source inspection establishes the target. Use
`session-context` instead of search only for genuinely broad or resumed work;
do not stack session context, search, and brief for one discovery need. A
normal bounded task should usually use no more than two Codexa calls.

Then make the source or docs edits with your normal editor or agent. Codexa MCP
tools do not edit source files. Run the targeted tests and verification commands
returned by the change plan.

The hooks written by `codexa init` review the dirty tree after edit tools, before
later shell verification. They do not replace one final review with the actual
verification evidence. The Claude plugin's Stop hook is also advisory until it
has a trusted command/invariant ledger. In either host, review once against the
saved plan after verification unless another true completion gate can carry
that evidence:

```bash
codexa post-edit-review /path/to/project \
  --task "rename this CLI option in docs and help text"
```

If you have already run checks, report them so Codexa can reason about what the
commands proved:

```bash
codexa post-edit-review /path/to/project \
  --task "rename this CLI option in docs and help text" \
  --ran-command "npm run check"
```

If you are unsure what to run, ask for a targeted test plan:

```bash
codexa test-plan /path/to/project --diff
# or, when you already know the target file:
codexa test-plan /path/to/project --file src/index.ts
```

The same selective policy applies to MCP tools inside an agent host:

```text
exact/local/source-sufficient -> source tools, zero Codexa calls
ambiguous/raw-sufficient -> search, then stop
exact materially risky + completion/Stop gate -> change_plan(saveSnapshot)
ambiguous materially risky + completion/Stop gate -> search -> change_plan(saveSnapshot)
exact materially risky + no completion gate -> change_plan(saveSnapshot) -> post_edit_review
ambiguous materially risky + no completion gate -> search -> change_plan(saveSnapshot) -> post_edit_review
```

The last line is the narrow three-call safety exception: ambiguity, material
risk, and no completion/Stop gate must all be present. These examples do not
authorize automatic chaining; each call must resolve a need the task still has.

## 5. Print a proof card

When a policy change, formal audit, release, or artifact handoff needs an
explicit proof packet, run:

```bash
codexa prove /path/to/project --task "rename this CLI option in docs and help text" --diff
```

The proof card reports freshness, dirty-tree state, read-first files, saved
snapshot status, verification commands that would cover the change if run,
reported verification evidence, local policy status, trust posture, and
remaining gaps.

## 6. What success looks like

After the work, you should be able to answer four questions with evidence:

- Which exact source evidence established the target?
- If a plan was warranted, what edit scope did it record?
- If a plan was warranted, did the dirty tree stay inside that scope?
- Which checks were run, and what behavior did they actually cover?

That evidence is the point of Codexa. It does not replace judgment, tests, or
code review; it makes the agent's context and verification claims easier to
inspect.

## Troubleshooting

If `codexa` is not found, confirm the npm global bin directory is on `PATH`, or
use the source-checkout flow with `npm link`.

If `session-start` reports `Index: missing`, run:

```bash
codexa index /path/to/project
```

If MCP tools do not appear in Codex or Claude Code, rerun the matching init
command for that host and then restart the agent host:

```bash
codexa init /path/to/project            # Codex CLI
codexa init /path/to/project --claude   # Claude Code
```

If the wrong repository is being indexed, rerun commands with the explicit
target repo path and inspect the generated MCP config in that repository.

If a command output looks heuristic-heavy, treat it as a reading list rather
than proof. Open the cited files and run the relevant checks. Pass the actual
commands to one final `post-edit-review` unless a true completion/Stop gate owns
the review. An edit-only hook is not a completion gate.

## Next steps

- Read the main [README](../../README.md) for commands, architecture, and
  limits.
- Read [Contributing](../../CONTRIBUTING.md) before opening a PR.
- Read [Codex SessionStart Hook](codex-sessionstart-hook.md) to understand the
  startup and edit hooks that `codexa init` writes.
- Read [No-Brainer Install Guide](no-brainer-install.md) to choose the best
  Codex or Claude Code install path.
