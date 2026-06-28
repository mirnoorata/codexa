# Changelog

## [0.7.0](https://github.com/mirnoorata/codexa/compare/v0.6.0...v0.7.0) (2026-06-28)


### Features

* **retrieval:** add graph packet exports ([e55ff6b](https://github.com/mirnoorata/codexa/commit/e55ff6b26fa01ee23658a94fc186a2da5d9c3196))
* **retrieval:** add relational packets for ranked context ([3741598](https://github.com/mirnoorata/codexa/commit/3741598d5e7664baa078b6789b8c54a2e579e8dc))


### Bug Fixes

* **mcp:** fail closed on ambiguous workspace routing ([e466f27](https://github.com/mirnoorata/codexa/commit/e466f2728a7d365753d2481474774bb136423873))

## [0.6.0](https://github.com/mirnoorata/codexa/compare/v0.5.1...v0.6.0) (2026-06-26)


### Features

* add Codexa proof-card install workflow ([6954597](https://github.com/mirnoorata/codexa/commit/69545973beb2b4e4bef6dcd04ab69c9a5fbde327))


### Bug Fixes

* **mcp:** prefer focused workspace routing ([c985e18](https://github.com/mirnoorata/codexa/commit/c985e1843af633c1f306142733cd7207b6bf8ab1))
* **test-plan:** require explicit verification scope ([b35a5bf](https://github.com/mirnoorata/codexa/commit/b35a5bf8bf7e5fd52c371da074bbaa8639fcc434))

## [0.5.1](https://github.com/mirnoorata/codexa/compare/v0.5.0...v0.5.1) (2026-06-24)


### Bug Fixes

* **mcp:** isolate workspace session routing ([c2645d6](https://github.com/mirnoorata/codexa/commit/c2645d6653421ea8f782ea3a967e347b1f8925fe))

## [0.5.0](https://github.com/mirnoorata/codexa/compare/v0.4.0...v0.5.0) (2026-06-23)


### Features

* **query:** add complexity review lane ([bf5de2b](https://github.com/mirnoorata/codexa/commit/bf5de2bfc7ad3efef090e068be2efdce0711bbe1))


### Bug Fixes

* **mcp:** resolve focused workspace sessions ([#64](https://github.com/mirnoorata/codexa/issues/64)) ([d732934](https://github.com/mirnoorata/codexa/commit/d73293457bf72eaa2d92c536ae3287931ee0d428))
* **mcp:** route workspace default before active rows ([e0727ad](https://github.com/mirnoorata/codexa/commit/e0727add2b02435f3e25903a88811a3f1bfd8b29))
* **static-analysis:** harden SCIP report ingestion ([d447faa](https://github.com/mirnoorata/codexa/commit/d447faa5c072ba932ed8872a75568a6f8d9209a6))
* **types:** align post-edit changed entries contract ([ed190ed](https://github.com/mirnoorata/codexa/commit/ed190ed9591dd9e24d3138fb6013ffba0ddf2e85))

## [0.4.0](https://github.com/mirnoorata/codexa/compare/v0.3.0...v0.4.0) (2026-06-17)


### Features

* enforce and CI-gate the retrieval eval; sharpen the companion surface ([b72d40e](https://github.com/mirnoorata/codexa/commit/b72d40eb7f713ee2b732471007a486c212860d54))

## [0.3.0](https://github.com/mirnoorata/codexa/compare/v0.2.2...v0.3.0) (2026-06-12)


### Features

* activate the edit-lifecycle governance loop for Claude Code ([#45](https://github.com/mirnoorata/codexa/issues/45)) ([ed1a91b](https://github.com/mirnoorata/codexa/commit/ed1a91b27f957ced86c27546e0bf5d7bdca74560))

## [0.2.2](https://github.com/mirnoorata/codexa/compare/v0.2.1...v0.2.2) (2026-06-12)


### Bug Fixes

* **cache-lock:** reclaim on owner.json mtime, not heartbeat content ([40b7e28](https://github.com/mirnoorata/codexa/commit/40b7e28fae8a5e70b1fd5f756f3e85ab2f66cfa7))
* **mcp:** reject non-loopback Host headers (DNS-rebinding guard) ([4e9efdf](https://github.com/mirnoorata/codexa/commit/4e9efdfba52151a772a7e90766b1343cd7930d76))
* **resolver:** exclude test files from inferred-target candidates ([cc8f746](https://github.com/mirnoorata/codexa/commit/cc8f746b26b9f56e9bd42d3e84ce674bc2f3e25f))
* **resolver:** match a unique path suffix before refusing a test target ([c42b524](https://github.com/mirnoorata/codexa/commit/c42b524d96cb5d67aa0b93daf6fe21d14cdd16c9))
* **verification:** model a faithful POSIX shell subset for coverage credit ([9db6ad7](https://github.com/mirnoorata/codexa/commit/9db6ad7074f756510aa18e2040435c57c268547c))


### Performance Improvements

* **query:** finite-guarded rankLog2 helper at all rank-log sites ([db2514a](https://github.com/mirnoorata/codexa/commit/db2514aa518fefe0096566728e94adeaf3098eb0))
