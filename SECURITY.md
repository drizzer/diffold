# Security Policy

## Supported Versions

`diffold` is currently pre-1.0. Please use the latest published version.

## Reporting a Vulnerability

Please report vulnerabilities **privately** via [GitHub Security Advisories](https://github.com/drizzer/diffold/security/advisories/new) — do not open a public issue for security reports. Include enough detail to reproduce the issue.

Non-sensitive bugs can be filed as regular [GitHub issues](https://github.com/drizzer/diffold/issues).

## Security Posture

- Read-only local CLI: no write/delete operations.
- No network access.
- No runtime dependencies in the compiled CLI.
- Uses Node-compatible built-in modules only.
- Explicitly skips symbolic links during traversal.
- Streams directory entries during traversal and fails closed when traversal limits are exceeded.
- Reports unreadable subdirectories and marks incomplete comparisons instead of silently exiting successfully.
- Content comparison streams files through SHA-256 in fixed-size chunks; it never buffers a whole file or retains contents. Pass `-c` / `--no-content` for a presence-only run that never opens file contents.
- JSON mode keeps stdout to a single JSON document; all diagnostics, `[skip]` lines, and warnings stay on stderr so piped output is safe to parse.
- `--exclude` prunes excluded directories before descending and cannot widen traversal beyond the resolved-root containment guard.
