# Contributing to Codexa

Thanks for looking. A few honest notes up front so we don't waste each
other's time.

## How this project works

- Codexa is **solo-maintained**. There is one person making decisions. That
  person has a day job and limited bandwidth.
- **Issues and PRs are reviewed in batches**, not in real time. A realistic
  response window is **days to weeks**. If a PR sits for a while, it is not
  personal — it is the queue.
- **Scope is deliberately narrow.** Codexa is a Codex-native code intelligence
  layer. Features that widen its scope (general-purpose code search, IDE
  integrations outside the MCP/CLI contract, language support beyond TS/JS/Py,
  LLM-based summarization) will almost always be closed as out-of-scope — not
  because they are bad ideas, but because bloat kills the "swift, nimble,
  optimal" property that makes this tool useful.
- **Not every working PR will be merged.** A merge is a maintenance
  commitment for the life of the project. A perfectly correct change that
  widens the surface area I have to maintain alone is still a "no." Say so up
  front in the PR description if you are unsure whether a change is in scope —
  an issue-first conversation is cheaper for both of us.

None of the above is meant to discourage contributions. It is meant to
calibrate expectations so contributors are not surprised.

## Before opening an issue

- Run `npm run check` locally and include the output if relevant.
- Include your Node version, the Codexa version, and the repo you were
  indexing when the problem happened.
- Minimal reproduction beats long prose. A 5-line snippet that breaks is more
  actionable than a paragraph of description.

## Before opening a PR

- **File an issue first** for anything beyond a typo fix or a documentation
  clarification. A quick "I am thinking of doing X, does this fit?" saves
  everyone from a rejected PR.
- The full verification gate must pass: `npm run check`. That runs:
  - `tsc --noEmit`
  - `npm run lint` (source hygiene scan)
  - `npm run privacy` (no publish-blocking paths / identifiers)
  - `vitest run`
- New behavior needs a test. Regression prevention is non-negotiable.
- Your commits can use whatever git identity you normally use. The
  maintainer's own commits in this repo are pseudonymous
  (`Codexa <codexa@example.invalid>`), but contributors are not asked to
  match. Squash-merge may collapse your commits; the squash commit keeps
  your original authorship via `Co-authored-by:` in the message.
- Keep the diff focused. Unrelated cleanups go in a separate PR.

## What tends to get merged quickly

- Bug fixes with clear repros and regression tests.
- Performance improvements with before/after measurements.
- Documentation fixes.
- Targeted improvements to existing verbs (`brief`, `post-edit`, `impact`,
  etc.) that don't widen scope.

## What tends to get closed

- New language indexers.
- New LLM-based analysis layers.
- "Rewrote this whole file in my preferred style" diffs.
- Dependency additions that could be done with a small local helper.
- Features that require configuration systems to toggle.

## Code of Conduct

Participation in this project is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md). The short version: be direct, be
useful, treat the maintainer as a person with limited time rather than a
service. Same from the maintainer's side.

## License

By submitting a PR, you agree your contribution is licensed under the
repository's [MIT License](LICENSE).
