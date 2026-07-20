# Changelog

## [0.15.2](https://github.com/mirnoorata/codexa/compare/v0.15.1...v0.15.2) (2026-07-20)


### Bug Fixes

* **cli:** honor Claude project roots ([35644b8](https://github.com/mirnoorata/codexa/commit/35644b8e28ae396de15138ccf1df475a1c2cfe5a))
* **init:** avoid stable hook rewrites ([a2601af](https://github.com/mirnoorata/codexa/commit/a2601af7815df88f6e649fd4d29bd7601cf9e06d))
* **init:** keep tracked wiring portable across worktrees ([eecaf01](https://github.com/mirnoorata/codexa/commit/eecaf01906616f785792a1ea4cae81f19a964d83))
* **init:** preserve Claude-only wiring ([a8fc8b7](https://github.com/mirnoorata/codexa/commit/a8fc8b75eba248379aa619158366d8b659e39d77))

## [0.15.1](https://github.com/mirnoorata/codexa/compare/v0.15.0...v0.15.1) (2026-07-19)


### Bug Fixes

* **benchmark:** reject invalid MCP timings ([3c0c15f](https://github.com/mirnoorata/codexa/commit/3c0c15f1344c46357b67098ebb3552b50c697f7e))
* **claude:** bound stop review deadline ([7fcf76a](https://github.com/mirnoorata/codexa/commit/7fcf76a299daee5f671b2128324d803e128d34c3))
* **claude:** preserve evidence-bearing final review ([12faa90](https://github.com/mirnoorata/codexa/commit/12faa90314a7619900c722f0deca1ceca6b33525))
* **context:** bound verification preview payload ([7729fec](https://github.com/mirnoorata/codexa/commit/7729fecef54e2cbd90000a066cbdd043366609c4))
* **context:** harden bounded agent routing ([09b5f96](https://github.com/mirnoorata/codexa/commit/09b5f96f833d2740c529614c77293b5f99313ac8))
* **context:** make terminal scopes self contained ([075e7fd](https://github.com/mirnoorata/codexa/commit/075e7fd3e6ca13270b5b40693d7a2210d99d971a))
* **context:** retain comparative source dependencies ([4fc5245](https://github.com/mirnoorata/codexa/commit/4fc5245ef9c0f48cc884819bccd0465158de9a92))
* **context:** retain explicit symbol dependencies ([e2b397e](https://github.com/mirnoorata/codexa/commit/e2b397e4520773d8d8311136ed0a7f04ea657ae6))
* **hooks:** surface missing pre-edit baselines ([4f98727](https://github.com/mirnoorata/codexa/commit/4f98727e582e00d2b9a03f00ff7207a23dcf2ce0))
* **intent:** keep review noun phrases read only ([fc1a360](https://github.com/mirnoorata/codexa/commit/fc1a360eb98231e2afafcfad347eed9579fd4471))
* **intent:** recognize nominal edit requests ([287616e](https://github.com/mirnoorata/codexa/commit/287616e3f020312994b50216fc161fa65433bd0b))
* **intent:** recognize nominal mutation subjects ([e3e7770](https://github.com/mirnoorata/codexa/commit/e3e7770cfaffcf4d727648da580754196a5df4e5))
* **intent:** recognize passive modal edits ([0f228e9](https://github.com/mirnoorata/codexa/commit/0f228e95323d1aa5a4af850f9b7732a80d7d010d))
* **intent:** recognize plural mutation requests ([c7a4c1e](https://github.com/mirnoorata/codexa/commit/c7a4c1ec6ed1356ba40d4bab5119fcfbea42c308))
* **lifecycle:** bind review state to executable mode ([8a50726](https://github.com/mirnoorata/codexa/commit/8a50726f0ca39263e8bf71dff5a2b2b0252cf2e4))
* **lifecycle:** contain snapshot rollback writes ([dc9866c](https://github.com/mirnoorata/codexa/commit/dc9866c0df2d901ece14f41be044c0bce4098d53))
* **lifecycle:** isolate snapshot rollback artifacts ([c9b4eee](https://github.com/mirnoorata/codexa/commit/c9b4eeefb274077849d3fec3f8e75e74c19de2d3))
* **lifecycle:** make snapshot authority monotonic ([6240343](https://github.com/mirnoorata/codexa/commit/62403437672eb7a51cc903c7c0af2dd6dc57a96c))
* **lifecycle:** preserve completed review authority ([5897791](https://github.com/mirnoorata/codexa/commit/5897791e66907aaabad2ec3d22d3ae8c94c4ef9c))
* **lifecycle:** preserve prior snapshot on interrupted replan ([5e49107](https://github.com/mirnoorata/codexa/commit/5e4910770797be0930da13a3f4012906f1e2a53e))
* **lifecycle:** recover newer snapshot authority ([2a472a1](https://github.com/mirnoorata/codexa/commit/2a472a1945c8f23b00babcbe138bf474f44f3b76))
* **lifecycle:** recover replaced blocked snapshots ([6076f0e](https://github.com/mirnoorata/codexa/commit/6076f0e06108f655e4c08a217bf135176bd5978d))
* **lifecycle:** recover snapshot publication authority ([82ed362](https://github.com/mirnoorata/codexa/commit/82ed3626b24841f6fb056df7683d0203f84d5b03))
* **lifecycle:** repair dangling latest authority ([7820523](https://github.com/mirnoorata/codexa/commit/7820523ea2dcfbd219d4bce60d1e013ff990f671))
* **lifecycle:** require durable snapshot governance ([1032069](https://github.com/mirnoorata/codexa/commit/103206945acb7e827be59bb4176b51085c45a3f0))
* **lifecycle:** retain final review after edit hooks ([c0d5ee2](https://github.com/mirnoorata/codexa/commit/c0d5ee232e9525a9e2c287f1433fb085f82b89e5))
* **mcp:** align compacted result authority ([2257092](https://github.com/mirnoorata/codexa/commit/2257092f03ea5d1eeb345b90b38dd87f4dcd3338))
* **mcp:** bind review prompt snapshots ([caf6b44](https://github.com/mirnoorata/codexa/commit/caf6b440a747aa70cc6bd1dfb5ab8b8188e13355))
* **mcp:** fail closed on descriptive next tools ([8677aaa](https://github.com/mirnoorata/codexa/commit/8677aaa43762b75b1312eeca65b6601c3207060c))
* **mcp:** keep bounded guidance authoritative ([512e4d7](https://github.com/mirnoorata/codexa/commit/512e4d7cd6817769128598ced1c2b6f6af1a7898))
* **mcp:** preserve bounded agent actionability ([eb925bd](https://github.com/mirnoorata/codexa/commit/eb925bd90d0df0c9b0cf81b9948032b35f0556ca))
* **mcp:** preserve complete bounded results ([6f7037d](https://github.com/mirnoorata/codexa/commit/6f7037d3c0f8a483397695584f4598ac8d8aa1f1))
* **mcp:** preserve exact search evidence delivery ([c088d20](https://github.com/mirnoorata/codexa/commit/c088d20f12a31e5ee8011f7c8202fdbeacba6372))
* **mcp:** preserve executable argument scope ([54b63b2](https://github.com/mirnoorata/codexa/commit/54b63b241b6f6e02b8053d75445ecc7660c30ead))
* **mcp:** preserve review description contract ([a1ca2e4](https://github.com/mirnoorata/codexa/commit/a1ca2e4fbdbeb0014d0b3755b70303dfcb87bcfe))
* **mcp:** require concrete dispatcher arguments ([f16b64f](https://github.com/mirnoorata/codexa/commit/f16b64fbef4b8bf90d1b9d6f7cc4a36abb9b55bd))
* **mcp:** retain unchanged follow-up authority ([b87d3d6](https://github.com/mirnoorata/codexa/commit/b87d3d644688fcb9c6091b415fe723ee0d202917))
* **mcp:** route core guidance through dispatcher ([946f7bf](https://github.com/mirnoorata/codexa/commit/946f7bf49c96d9c92745f3ff487fbdbd7838435b))
* **plugins:** preserve review evidence authority ([24ef2ec](https://github.com/mirnoorata/codexa/commit/24ef2ec6c9d2654760556607762fdb7c85f32dba))
* **post-edit:** declare replan snapshot writes ([129bf7f](https://github.com/mirnoorata/codexa/commit/129bf7f5bc2078830b9c62f2d25d28f23aaa133e))
* **routing:** bind candidate replays to full scope ([70cb23c](https://github.com/mirnoorata/codexa/commit/70cb23c261dbf2e33c221e4fb69a1c6de01059c6))
* **routing:** canonicalize candidate replay scope ([90d399e](https://github.com/mirnoorata/codexa/commit/90d399e8245f805e3d3b78a9bccc8a31c65a71a7))
* **routing:** canonicalize explicit path mentions ([15000f7](https://github.com/mirnoorata/codexa/commit/15000f70fd21e4c19ef634e2809d312b6a1b8a68))
* **routing:** enforce repository edit authority ([6154fd6](https://github.com/mirnoorata/codexa/commit/6154fd638da3fc1f068a834229bb90bc6790777b))
* **routing:** honor directed task language ([510b356](https://github.com/mirnoorata/codexa/commit/510b35698831a9b0a81bffc283a897b8309eedc7))
* **routing:** preserve canonical target scope ([be3b3de](https://github.com/mirnoorata/codexa/commit/be3b3de115bbd9014a930b78a395cddfee04e6d8))
* **routing:** reject parent segment targets ([649a44e](https://github.com/mirnoorata/codexa/commit/649a44e8ada7789c8baefa303701026c9688f83d))
* **routing:** reject unsafe target syntax ([e030030](https://github.com/mirnoorata/codexa/commit/e0300303376754e3d143c459d13d4a0b59b69a76))
* **routing:** require reads for untracked targets ([b476410](https://github.com/mirnoorata/codexa/commit/b476410af1d372dc52d03f5bd7f778bd92998e54))
* **search:** detect bounded result overflow ([6f18261](https://github.com/mirnoorata/codexa/commit/6f182610b23dbaf02f7de390d9d8105cc09d0c7c))


### Performance Improvements

* **mcp:** canonicalize agent guidance contracts ([988b282](https://github.com/mirnoorata/codexa/commit/988b28200cb0836f7e6d3c2cffce159ace853843))
* **mcp:** omit exact search detail artifacts ([af03d92](https://github.com/mirnoorata/codexa/commit/af03d927ba9559148b0aa5f540ed47c0b6461263))
* **mcp:** reduce agentic Codexa overhead ([2ca2365](https://github.com/mirnoorata/codexa/commit/2ca23656711f146bdf58235dd834d6069a68b4be))

## [0.15.0](https://github.com/mirnoorata/codexa/compare/v0.14.1...v0.15.0) (2026-07-14)


### Features

* **cli:** add post-edit-review --format json and opt-in --exit-code ([#108](https://github.com/mirnoorata/codexa/issues/108)) ([74e65c4](https://github.com/mirnoorata/codexa/commit/74e65c4356347817bcf61c416af65c8060a69520))

## [0.14.1](https://github.com/mirnoorata/codexa/compare/v0.14.0...v0.14.1) (2026-07-14)


### Bug Fixes

* **workflows:** harden usefulness validation ([#106](https://github.com/mirnoorata/codexa/issues/106)) ([9c9aaf5](https://github.com/mirnoorata/codexa/commit/9c9aaf5c2b688a02ab84f4ba19a732b130fcaa2c))

## [0.14.0](https://github.com/mirnoorata/codexa/compare/v0.13.0...v0.14.0) (2026-07-14)


### Features

* **review:** add shared committed change receipts ([f058c44](https://github.com/mirnoorata/codexa/commit/f058c447d480d6183137150700412273e3b8238b))


### Bug Fixes

* **action:** isolate packaged review bootstrap ([084c1fb](https://github.com/mirnoorata/codexa/commit/084c1fb5b711a8c5512cd858c8ba77c10cf7a174))
* **mcp:** expose portable change review plans ([eb8dbe2](https://github.com/mirnoorata/codexa/commit/eb8dbe27dfe2f3f5f6e94d09b1d68995978837bf))
* **review:** bind portable plans to validated files ([26b4b17](https://github.com/mirnoorata/codexa/commit/26b4b1745116876a5878b2342c754fb3fc56f071))
* **review:** require deterministic clean change evidence ([f7d3aa4](https://github.com/mirnoorata/codexa/commit/f7d3aa48015ef11f8be410142ccbba50a5d5e05e))
* **review:** verify snapshot identity before opening ([262c5e5](https://github.com/mirnoorata/codexa/commit/262c5e581669addcaf72c8d1fb376858a2d8c058))

## [0.13.0](https://github.com/mirnoorata/codexa/compare/v0.12.0...v0.13.0) (2026-07-13)


### Features

* **mcp:** reduce transport overhead with decision-safe parity ([#102](https://github.com/mirnoorata/codexa/issues/102)) ([a7c5492](https://github.com/mirnoorata/codexa/commit/a7c5492cfc78ef49764de183857631ed05078773))

## [0.12.0](https://github.com/mirnoorata/codexa/compare/v0.11.0...v0.12.0) (2026-07-13)


### Features

* **eval:** report post-edit decision telemetry ([#100](https://github.com/mirnoorata/codexa/issues/100)) ([8d4d078](https://github.com/mirnoorata/codexa/commit/8d4d078230ad2216d605240bd620180c1a861cdc))

## [0.11.0](https://github.com/mirnoorata/codexa/compare/v0.10.0...v0.11.0) (2026-07-13)


### Features

* **eval:** add external agent A/B harness ([#98](https://github.com/mirnoorata/codexa/issues/98)) ([98f03a1](https://github.com/mirnoorata/codexa/commit/98f03a114412902da365139b7f8692b7617e8a88))

## [0.10.0](https://github.com/mirnoorata/codexa/compare/v0.9.0...v0.10.0) (2026-07-13)


### Features

* **lifecycle:** enforce worktree-bound governance ([#97](https://github.com/mirnoorata/codexa/issues/97)) ([8311b0a](https://github.com/mirnoorata/codexa/commit/8311b0ac04ebb26a0d255b1aa83248a299901541))
* **verification:** harden runner classification ([#92](https://github.com/mirnoorata/codexa/issues/92)) ([f79bbe3](https://github.com/mirnoorata/codexa/commit/f79bbe36c5ca6ec4a08427d5b6ab4eb0bc4c5e46))

## [0.9.0](https://github.com/mirnoorata/codexa/compare/v0.8.0...v0.9.0) (2026-07-10)


### Features

* **verification:** expose trust tiers and scale semantic indexing ([#91](https://github.com/mirnoorata/codexa/issues/91)) ([ac4ec47](https://github.com/mirnoorata/codexa/commit/ac4ec4700def865aea0425d3620c5d41c254cc13))


### Bug Fixes

* **core:** kill false-positive drift blocks, pin node truth, unfreeze MCP routing, prune ghost packets ([#89](https://github.com/mirnoorata/codexa/issues/89)) ([f2a1bbd](https://github.com/mirnoorata/codexa/commit/f2a1bbdbb4b9750bf4cfbf7d72dd1704ce791f87))

## [0.8.0](https://github.com/mirnoorata/codexa/compare/v0.7.2...v0.8.0) (2026-07-04)


### Features

* **mcp:** surface workspace skill hints ([7aa3f50](https://github.com/mirnoorata/codexa/commit/7aa3f5068d8357a8090c7abf709c55d2a1aca5d1))

## [0.7.2](https://github.com/mirnoorata/codexa/compare/v0.7.1...v0.7.2) (2026-07-01)


### Bug Fixes

* **mcp:** route workspace defaults without stale session pins ([1b3d6f1](https://github.com/mirnoorata/codexa/commit/1b3d6f184b165f5845c3fb9c60943291a28fe749))

## [0.7.1](https://github.com/mirnoorata/codexa/compare/v0.7.0...v0.7.1) (2026-06-28)


### Bug Fixes

* **cli:** route focused workspace sessions explicitly ([924c3bc](https://github.com/mirnoorata/codexa/commit/924c3bca1babb87e64d129f487a30c25b209bfcb))

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
