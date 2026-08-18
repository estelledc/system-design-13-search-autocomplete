# Security policy

This repository is an educational system-design practice. Do not submit real search logs, user identities, credentials, policy
lists, or confidential incidents.

## Reporting

Use a private GitHub security advisory for repository vulnerabilities. Include the affected commit, a minimal synthetic
reproduction, expected versus observed behavior, and impact. Never include live tokens, database URLs, raw query/prefix data,
idempotency keys, or third-party confidential material.

Public issues are suitable for ordinary feature/design discussion. This repository is not an emergency or production service.

## Supported version

Only the current default branch is maintained. No release, deployment, SLA, or backward-compatibility promise exists.

## Known exclusions

The project does not provide TLS termination, production identity/roles, rate limiting, privacy guarantees, abuse/content-safety
coverage, deletion/retention compliance, cache purging, backup/restore, failover, or deployment hardening. Read the
[threat model](docs/threat-model.md) and use synthetic data only.
