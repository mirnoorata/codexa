# Use Codexa with Cursor

Codexa gives your coding agent a map of a proposed change and a checklist of
what was actually checked afterward. It does not write the change for you.
Think receipts, not a second driver grabbing the steering wheel.

## Install

The `--cursor` setup flag is unreleased; npm version 0.19.0 does not include it.
To try this branch, run `npm ci` and `npm run build` in the Codexa checkout,
then `node dist/cli.js init /path/to/project --cursor --no-hooks`.
The published-package command below applies after the feature is released.

Install Node.js 22 or newer and Git. From your repository, run:

```bash
npx -y @mirnoorata/codexa@latest init . --cursor --no-hooks
```

This indexes the repository, writes `.cursor/mcp.json`, and refreshes Codexa's
`.codex/config.toml`. `--no-hooks` removes Codexa-managed Codex hooks; omit it
if you also use those hooks in Codex. Unrelated MCP servers are preserved.

Open the repository folder in Cursor and enable the generated Codexa server in
its MCP settings. The default exposes three tools: `search`, `change_plan`,
and `capabilities`. A configuration file alone does not prove the editor loaded
it: check that the tools appear and make a small `search` request.

The configuration pins the Codexa version that performed setup, uses `npx`, and
passes `${workspaceFolder}` as the repository. It can be committed and reused
in another clone, including paths with spaces. Updating means rerunning the
installation command. The first launch may download the pinned package.
If a server name already belongs to another tool, use `--server-name codexa-local`.

Cursor documents project configuration and variable expansion in its
[MCP guide](https://cursor.com/docs/mcp). These instructions cover project-level
stdio setup; no Cursor account integration or desktop extension is installed.

## Use it selectively

- Know the exact file or symbol? Read it and run the relevant tests directly.
- Unsure where behavior lives? Ask `search` once, then inspect the returned files.
- Making a substantial change? Ask `change_plan` to save a snapshot, implement
  the change, and run its checks. Invoke the returned `capabilities` call for
  `post_edit_review` once, with the commands and results you actually ran.

The normal planned workflow takes two Codexa calls. Listing or describing the
review operation first is unnecessary when the plan already supplied its inputs.
A reported passing command is still reported evidence; it is not a witnessed run.

TypeSafe reranking is optional. Without a key, local deterministic search still
works. To enable it, add `--typesafe` to the generated `serve` arguments and
expose `TYPESAFE_API_KEY` to the server process using your host environment or
Cursor's supported environment configuration. Never commit
a key. Reranking sends bounded candidate excerpts to TypeSafe; use `--no-typesafe`
in the generated `serve` arguments when source must remain entirely local.

To remove Cursor wiring, delete only the Codexa entry from `.cursor/mcp.json`.
Other server entries and your source can stay exactly where they are.

## Add semantic information when needed

Codexa can use installed TypeScript/JavaScript and Python language servers for
bounded, read-only assistance. Install `typescript-language-server`, or
`basedpyright`/`pyright`, in your own development environment. Enable `--lsp`
on supported CLI queries or set `CODEXA_LSP=1` for the server. Missing servers
produce warnings; Codexa does not install them or maintain an always-on daemon.

For other language tooling, produce a SCIP index with your language's indexer,
export it with `scip print --json`, then import that JSON:

```bash
codexa static-analysis . --scip-report /path/to/index.scip.json
```

This imports bounded, derived symbols and relationships. It does not run the
indexer, confer exact semantic authority, or add native language-server support.
Use it alongside source inspection and your compiler/tests. See the repository's
[README](../../README.md#static-analysis-reports) for the evidence model.

Go repositories additionally have conservative package-test recognition for
commands such as `go test -count=1 ./...`. Nested modules, filtered tests,
build-constrained files, and packages with `TestMain` need explicit inspection;
Codexa does not turn a successful exit into proof that every test ran. The
[Go command documentation](https://pkg.go.dev/cmd/go) explains test selection.
