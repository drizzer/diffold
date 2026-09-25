# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.0.2] — 2026-09-25

Hardening and release-safety update. Behavior is backward compatible with
`0.0.1` for successful comparisons; the changes tighten validation, traversal
bounds, incomplete-traversal reporting, and the publish pipeline.

### Fixed

- Reject empty and whitespace-only directory arguments before path resolution. `diffold "" <dir>` previously resolved the empty argument to the current working directory.
- Preserve significant leading and trailing spaces in directory names instead of silently trimming them to a different path.
- Stop expanding unsupported `~user/...` spellings into the current home directory, which previously produced a corrupted path such as `<home>user/...`.
- Restrict Windows drive-letter normalization to Windows, so POSIX names such as `c:notes` are no longer rewritten as `c:/notes`.
- Require every requested folder to validate. A mistyped folder in a three-folder request no longer produces a silent two-folder report with exit code 0.
- Report unreadable subdirectories as `[skip] ...`, mark them per folder in the report, print a `WARNING: Comparison incomplete` message, and exit 1 instead of silently returning success for a partial comparison.

### Changed

- Stream directory entries with `fs.opendir()` instead of materializing complete directory listings in memory.
- Count every visited file and directory against `DIFFOLD_MAX_FILES`, so directory-only trees can no longer bypass the file-count limit.
- Keep documentation and security claims aligned with observed behavior for traversal bounds, argument validation, and incomplete traversals.
- Clarify that Bun is the primary development runtime while retaining npm/Node.js compatibility, and document Deno source execution as best-effort.
- Make manual `publish.yml` runs tag-based and dry-run by default, and pin the release npm CLI instead of using `npm@latest`.

### Added

- Four-folder comparison tests.
- Five-folder comparison tests.
- Empty and whitespace-only argument tests.
- Significant-whitespace path tests.
- Unsupported tilde-user path test.
- Strict all-folders-must-validate test.
- Traversal-entry budget test.
- Incomplete-traversal reporting test.
- Windows CI verification job covering typecheck, both test runners, build, compiled CLI, and publish payload.
- Packed-tarball CLI smoke test on Ubuntu.
- Full typecheck, test, build, smoke, and payload verification gates before publishing.

### Security

- Reduced memory-exhaustion exposure from very large directories and directory-only traversal bombs.
- Prevented silently successful reports after an incomplete filesystem traversal.
- Hardened the release path against accidental publication from an arbitrary branch or a mismatched tag.

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
