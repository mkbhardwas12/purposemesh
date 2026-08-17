# Contributing to PurposeMesh

Thank you for helping improve PurposeMesh. PurposeMesh is a security
reference implementation, so changes should be small, reviewable, and explicit
about which guarantees are implemented versus proposed.

## Start here

1. Search existing issues before opening a new one.
2. Use an issue form for bugs, documentation changes, or adapter proposals.
3. For security vulnerabilities, follow [the private reporting
   policy](.github/SECURITY.md); do not open a public issue.
4. Discuss large policy-model or adapter changes before implementation.
5. Check the [public roadmap](ROADMAP.md) for current evidence gates and explain
   which gate the proposed change advances.

## Local workflow

PurposeMesh requires Node.js 24+ and npm 11+.

```bash
npm ci
npm run preflight
npm audit --omit=dev --audit-level=high
```

`preflight` runs all workspace typechecks, tests, and production builds. A pull
request should not weaken deny-by-default behavior, field projection, purpose
binding, reviewer independence, token invalidation, rollback, or capability
gating. Use `npm ci` for a lockfile-reproducible install before verification.

## Pull-request expectations

- Explain the problem, the security boundary, and the user impact.
- Add tests for allow, deny, stale-state, and failure behavior.
- Keep generated databases, credentials, `.env` files, local paths, and `.tmp/`
  artifacts out of the change.
- Update the architecture and security documents when guarantees or boundaries
  change.
- Treat external target output as preview-only until an adapter has apply,
  revoke, read-back, drift, rollback, and equivalence evidence.
- For an adapter proposal, identify the exact target/version, native controls,
  unsupported semantics, read-back source, rollback strategy, drift behavior,
  and conformance-test plan. A generated configuration preview is not a
  conformant adapter and must not be described as one without published,
  target-version-scoped passing evidence.
- Use synthetic data in screenshots, fixtures, examples, and bug reports.

By contributing, you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE).
