# Changelog

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
