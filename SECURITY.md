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
