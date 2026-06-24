# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.0.1] — 2026-06-24

Initial release of `diffold`.

### Added

- TypeScript CLI to diff 2–5 directories, published for `npx diffold <dirs>` / `bunx diffold <dirs>`.
- Structure-only comparison (file presence/absence by relative path).
- Recursive file collection via iterative DFS (stack-based).
- Set-based diff logic: unique files, missing files, common intersection.
- ANSI color-coded terminal output (RED, GREEN, YELLOW, BLUE).
- Path normalization: `~` expansion, Windows drive letter handling, forward/backslash support.
- Directory validation: existence check + `isDirectory()` guard.
- Explicit symlink skip via `entry.isSymbolicLink()` check.
- Usage message on invalid argument count (2–5 directories required).
- Error messages for missing directories and non-directory paths; `main()` with `.catch()` for unhandled rejections.
- Cross-runtime support: Node.js 22+ for the published package, with Bun and Deno supported for source execution; runtime detection shapes the usage message.
- `tsconfig.json` with `strict: true` and `types/cross-runtime.d.ts` (Deno/Bun globals).
- Cross-runtime scripts: `test`, `test:bun`, `test:deno`, `start`, `start:bun`, `start:deno`.
- npm publish infrastructure: esbuild-based `build` script emits `dist/index.js` with a portable CLI shebang.
- Package metadata for npm consumers: `bin`, `main`, `engines`, repository, bugs, homepage, funding, and publish `files` list.
- Test suite with 16 tests covering the happy path, unique/missing/common separation, three-folder comparison, nested recursion, empty folders, symlinked folders, duplicate arguments, equivalent path spellings, `~` expansion, invalid and missing arguments, traversal limits, and ANSI sanitization — committed fixtures (`test_dir1`, `test_dir2`) plus temporary trees built per test for edge cases.
- Coverage that invalid-argument usage references `diffold <dir1>`.
- Top-level `README.md`, `LICENSE`, and `SECURITY.md` for npm/GitHub users.
- README polish: shields.io badges (npm version, downloads, license, node) and `assets/demo.svg` — a terminal-style rendering of the color-coded report.
- `bun.lock` is the only lockfile, matching the declared `packageManager`; `package-lock.json` and `yarn.lock` are gitignored so installs resolve to one pinned dependency tree.
- `bin.diffold` points to the compiled `dist/index.js` so `npx` and `bunx` run the CLI without a TypeScript loader.
- `packageManager: bun@1.4.0` and `engines.bun: ">=1.4.0"` declared in `package.json`; README requirements document Bun 1.4+ for `bunx` and for source execution.
- Publish `files` list ships `assets/demo.svg` so the README example renders from the published tarball.
- `start` builds and runs the compiled CLI; source-runtime scripts remain available as `start:bun` and `start:deno`.
- `node:`-prefixed built-in imports (`node:fs/promises`, `node:path`, `node:os`) for runtime portability.
- Tests run on `node:test` + `child_process.spawn`, so the same suite executes under Node.js, Bun, and Deno.
- Named `async function main()` with a `.catch()` handler, and ANSI escapes centralized in `RED`/`RESET` constants.
- Build script quotes `--external:"node:*"`, so `bun run build` works despite Bun's script shell glob expansion.
- `prepare` script builds `dist/` during install, so installing straight from Git produces a working `bin` target.
- GitHub Actions workflows: `ci.yml` (typecheck, both test runners, build, compiled-CLI smoke test, publish-payload check, Node 22/24/26 matrix, non-blocking Deno job) and `publish.yml` (release-tag/version guard, then `npm publish --provenance`).

### Security

- Traversal containment compares fully resolved paths, and symlinked entries are never followed, so traversal cannot escape a compared folder.
- Folders are canonicalized once with `fs.realpath()` before traversal, so validation and traversal operate on the same path with no window between check and use.
- File names, printed paths, and error messages are stripped of ANSI and control sequences, so a crafted name cannot rewrite the user's terminal.
- Traversal is bounded by `DIFFOLD_MAX_DEPTH` (default 256) and `DIFFOLD_MAX_FILES` (default 500,000), so a pathological tree fails with a clear error instead of exhausting memory.
- Directory validation uses a single `fs.stat()` call covering both existence and type.
- Diagnostics go to stderr, keeping stdout limited to the report.
