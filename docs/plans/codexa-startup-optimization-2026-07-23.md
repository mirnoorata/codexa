# Codexa startup optimization execution plan

This is the drift ledger for the Codexa project-start redesign. The target is
truthful, low-noise readiness—not token reduction in isolation.

The machine-readable measurement boundary, baseline observations, current
budgets, pending external evaluation, and retain/conditional/remove
classification are committed in
[`codexa-startup-context-inventory.json`](./codexa-startup-context-inventory.json).
`npm run startup:context-check` rejects drift in repository-controlled claims.

## Required sequence

1. Measure startup inputs and classify each as essential evidence, conditional
   evidence, duplicated guidance, or removable bloat.
2. Keep direct source navigation as the zero-Codexa default; expose only the
   small core MCP surface while preserving advanced operations behind the
   dispatcher.
3. Make SessionStart a bounded, versioned receipt with separate routing,
   config/profile, index, local setup, and current-thread MCP facets.
4. Fail closed for ambiguous or terminal workspace routing and for explicit
   selectors that cannot resolve their declared repository.
5. Generate checkout-local config, hooks, index, and bootstrap evidence in the
   actual fresh worktree; never copy machine-local wiring between checkouts.
6. Bind setup evidence to Git/worktree identity, build inputs, the complete
   runtime tree, managed config/hooks, the installed dependency inventory, and
   the active Node runtime.
7. Split receipt consumption by purpose. SessionStart must cheaply validate
   durable setup identity before strict startup or auto-refresh writes; the
   explicit completion gate must fully recompute source, output, HEAD, and
   dependency inventory.
   Shared adoption must delegate adoption-scope validation to a trusted
   canonical Codexa CLI, binding the generated runtime and dependencies while
   allowing source/HEAD evolution, and must never execute worktree code before
   that validation succeeds.
8. Keep platform claims scoped: POSIX may attest managed hooks; native Windows
   is MCP-only; neither lane may claim the host's current-thread MCP handshake.
9. Protect every startup-managed write boundary from redirected directories,
   files, hardlinks, stale snapshots, unsafe lock reclamation, and interrupted
   lock publication.
10. Verify serialized fresh-worktree setup, clean locked dependency repair,
    pre-build source-race rejection, durable versus volatile drift behavior,
    native Windows execution, and bounded output/latency.
11. Run the full repository gate and repeated adversarial reviews against the
    exact committed diff; fix only actionable findings and repeat to zero.
12. Complete the normal branch, draft-PR, ready, merge, canonical-sync,
    rebuild/reindex, public-surface, and behavior-smoke workflow.

## Invariants

- A compact startup result may omit evidence detail, but it may not collapse
  unknown, stale, missing, or host-unobservable state into `ready`.
- Removing prompt or schema text is useful only when capability and diagnostic
  reachability remain intact.
- A setup receipt is locally validated freshness evidence, not a signature,
  tamper-proof claim, deployment proof, or MCP-handshake proof.
- A receipt inside a worktree is never authority to execute that worktree's
  generated CLI; trusted controllers use their canonical Codexa runtime.
- The one-time bootstrap performs a clean locked install before executing
  dependency binaries; repeated conversations validate a bounded install seal
  instead of rescanning or reinstalling the dependency tree.
- Startup validation may read bounded durable evidence; it must not mutate
  redirected state, block ordinary source evolution, or silently refresh from
  an unverified durable setup.

## Completion checklist

- [x] Core MCP exposure and capability-dispatch routing implemented.
- [x] Versioned, bounded SessionStart facets implemented.
- [x] Workspace routing and managed-state safety hardened.
- [x] Fresh-worktree POSIX and native-Windows setup lanes tracked.
- [x] Setup receipt production validator and SessionStart consumer implemented.
- [x] Dependency-tree and build-output preflight repair implemented.
- [ ] Full source/security/benchmark/evaluation gate passes on the final diff.
- [ ] Latest adversarial pass reports no actionable findings.
- [ ] Markdown and PDF PR summaries reflect the final committed evidence.
- [ ] Draft PR is clean, ready, merged, and the canonical checkout is synced.
- [ ] Post-merge runtime, public surface, and real behavior smokes are verified.
