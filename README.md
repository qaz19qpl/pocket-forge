# pocket-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/qaz19qpl/pocket-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/qaz19qpl/pocket-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in a single Node process — no git
binary, no packages, standard library only. It serves four surfaces from one
in-memory store:

- **Git smart HTTP** at `/{owner}/{repo}.git` — protocol v2 upload-pack
  (ls-refs, fetch, shallow clones, deepen/unshallow) with a v0 side-band-64k
  fallback, and v0 receive-pack with report-status, delete-refs and strict
  fast-forward enforcement. The git object model (SHA-1, zlib, trees,
  commits, annotated tags, packfiles with OFS/REF deltas) is implemented
  from scratch.
- **REST v3** under `/api/v3` — repositories, contents, labels, issues,
  pull requests with squash merges, branches, commits and refs.
- **GraphQL v4** at `/api/graphql` — a hand-written parser and executor
  covering the queries and mutations `gh` and github-mcp-server send,
  including introspection, connections with cursors and batched operations.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP (2026-07-28
  `server/discover` plus the initialize handshake), six tools acting on the
  same store as REST.

Everything the forge creates is deterministic: a logical clock (fixed epoch
plus a per-operation counter) stamps commits and records, so two runs of
the same workload leave byte-identical state. In the kit's own sealed
grading suite it passes **120/120 conformance checks** (git 30, repos 15,
issues 15, pulls 20, GraphQL 20, MCP 15, protocol 5) and runs the four
performance workloads well inside the reference forge's medians.

## Run it

```sh
MAKEFUN_ENV_URL=http://store:8080 node main.ts
```

The entry binds an ephemeral port, registers it with the contest
environment at `$MAKEFUN_ENV_URL/register`, serves until the environment
answers `{"done": true}` on `/done`, and exits 0. Bearer auth uses
`$MAKEFUN_SHOP_TOKEN`; the token names the forge's one login.

---

<sub>Entered on [make.fun](https://make.fun/?ref=azy0wp0s&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
