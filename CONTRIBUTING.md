# Contributing to diffold

Thanks for your interest in contributing! Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first; enforcement reports go to **abuse@softalisa.com**.

## CLI Surface

```
diffold <dir1> <dir2> [... <dirN>] [options]
```

| Option | Effect |
|--------|--------|
| `-c`, `--no-content` | Compare paths only (content comparison is on by default) |

## Development Setup

```bash
git clone https://github.com/drizzer/diffold.git
cd diffold
bun install
```

Bun 1.4+ is the package manager (see `packageManager` in `package.json`).
`bun.lock` is the only lockfile; `package-lock.json` and `yarn.lock` are
gitignored on purpose so an accidental npm/yarn install cannot produce a second,
divergent dependency tree.

## Scripts

| Command | Description |
|---------|-------------|
| `bun run build` | Bundle `index.ts` into `dist/index.js` with esbuild |
| `bun run typecheck` | Type check without emitting |
| `bun run test` | Run tests with the Node test runner (via `tsx`) |
| `bun test` | Run tests with the Bun test runner |
| `bun run test:deno` | Run tests with the Deno test runner |
| `bun run start` | Build, then run the compiled CLI |
| `bun run start:bun` | Run from source with Bun |
| `bun run start:deno` | Run from source with Deno |
| `bun run start:dist` | Run the already-built `dist/index.js` |

`bun run prepublishOnly` is the full local gate (typecheck + Node tests + Bun
tests + build) and runs automatically on `npm publish`. Local gates are necessary but
not sufficient: a real publish also requires a green CI run for the tagged commit and
manual approval through the `npm-publish` GitHub Environment.

## Project Structure

```
index.ts                  # Entire CLI implementation (intentionally single-file)
types/cross-runtime.d.ts  # Deno/Bun global type declarations
tests/index.test.ts       # Test suite, exercised through the CLI as a subprocess
docs/                     # Local maintainer docs (gitignored, not shipped)
.github/workflows/        # ci.yml and publish.yml
```

`index.ts` is deliberately a single file so the compiled CLI has **zero runtime
dependencies**. Do not split it without a strong reason and a changelog note.

## Making Changes

1. Create a branch from `main`.
2. Make your changes.
3. Type check: `bun run typecheck`.
4. Run the suite on every supported runtime:
   `bun run test && bun test` (and `bun run test:deno` if you touched runtime
   conditionals). The suite currently has 32 tests.
5. Build and smoke test:
   `bun run build && node dist/index.js tests/test-folders/test_dir1 tests/test-folders/test_dir2`
6. Open a pull request.

## Code Style

- TypeScript `strict` mode; explicit types on exported functions
- `interface` for extendable object shapes, `type` for unions/intersections
- Avoid `any`; use `unknown` for external input
- Prefer immutable updates (spread operator)
- No stray debug logging — `console.log` is the intended report channel
- Keep files focused. Exception: `index.ts` is intentionally single-file
- Add comments only for *why*, not *what*

## Testing

Tests invoke the CLI as a subprocess, which is what makes one suite runnable
under Node, Bun, and Deno.

- Follow Arrange-Act-Assert
- Use descriptive test names that state the behavior under test
- Build edge-case trees under `os.tmpdir()` and clean them up in a `finally`
- Exercise traversal guards via `DIFFOLD_MAX_DEPTH` / `DIFFOLD_MAX_FILES`
  overrides rather than creating huge fixtures
- Cover the error path, not just the happy path: unreadable subdirectories must
  report incomplete and exit non-zero

## Reporting Bugs and Security Issues

- Non-sensitive bugs: [GitHub issues](https://github.com/drizzer/diffold/issues)
- Security issues: report **privately** via
  [GitHub Security Advisories](https://github.com/drizzer/diffold/security/advisories/new).
  Please do not open a public issue first.

## Pull Request Checklist

- [ ] `bun run typecheck` passes
- [ ] `bun run test` and `bun test` both pass
- [ ] `bun run build` succeeds and the compiled CLI runs
- [ ] `CHANGELOG.md` updated for user-facing changes
- [ ] `README.md` updated if flags, output, or guarantees changed
- [ ] `SECURITY.md` updated if a security guarantee changed
- [ ] Traversal or security guarantees still match `SECURITY.md`

## Distribution Note

`CODE_OF_CONDUCT.md` and `CONTRIBUTING.md` live on GitHub only. `package.json` uses
an explicit `files` allowlist (`dist/`, `assets/demo.svg`, `README.md`,
`CHANGELOG.md`, `SECURITY.md`), so community files are not part of the npm tarball.
