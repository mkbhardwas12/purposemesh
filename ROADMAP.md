# PurposeMesh roadmap

PurposeMesh is an open-source **Technical Preview**. This roadmap describes the
evidence the project intends to produce; it is not a promise of dates, target
support, compatibility, or production readiness.

The project advances a capability only when an executable test or independently
inspectable artifact supports the claim. Architecture diagrams and generated
target-shaped JSON are useful design evidence, but they are not proof of native
enforcement.

## Direction

PurposeMesh is not trying to replace enterprise identity, policy-decision, or
relationship systems. Its proposed role is an authorization enforcement
assurance layer:

```text
IdP / IGA + OPA / Cedar / OpenFGA / existing authorization
                    -> Contract Capsule
                    -> target-native compiler
                    -> fidelity gate
                    -> apply or revoke
                    -> read-back
                    -> equivalence evidence and drift reconciliation
```

The differentiating hypothesis is that a policy decision or offboarding request
is not sufficient evidence that every target installed—or removed—the exact
intended row, field, purpose, and lifecycle boundary.

## 0.1 — Local reference path

Status: **Technical Preview implemented**

- Deny-by-default React, Fastify, policy-core, and SQLite path.
- Hybrid RBAC, ABAC, and ReBAC decisions with purpose, classification, row, and
  allow-first field obligations.
- Deterministic 100,000-record synthetic authorization-isolation fixture across
  four modeled pipeline families. This is test evidence, not a capacity claim
  or performance benchmark.
- Dual approval, separation of duty, JIT access, recertification, local
  offboarding, audit evidence, and recovery tooling.
- Minimal AuthZEN-shaped evaluation adapter.
- Target-shaped compiler previews that remain fail-closed when capability
  fidelity cannot be proved.

## 0.2 — First real enforcement loop

Target outcome: prove the complete assurance loop against one accessible,
versioned external system. PostgreSQL row-level security is the preferred first
reference target, subject to design review.

The adapter is not complete until automated tests prove:

- deterministic plan and diff;
- idempotent apply and revoke;
- native row and field enforcement, or an explicit fail-closed result;
- read-back from authoritative target state;
- canonical desired-versus-actual comparison;
- deliberate drift detection;
- rollback after partial failure;
- PDP-versus-target equivalence for allow and deny cases;
- offboarding removal evidence; and
- reproducible local deployment through one documented command.

## 0.3 — Interoperability and a second target

- Track the final OpenID AuthZEN Authorization API and publish conformance tests;
  do not claim conformance before the required surface is implemented.
- Accept verified identity and lifecycle facts from an enterprise-style OIDC and
  SCIM integration path.
- Define a versioned catalog/schema/classification/ownership ingestion contract.
- Add a second independent adapter, likely Elasticsearch/OpenSearch field- and
  document-level security, only after the first adapter closes the loop.
- Publish adapter authoring documentation and reusable fidelity-test fixtures.

## 0.4 — Operational and supply-chain hardening

- Replace single-writer snapshots with transactional shared state and an
  outbox-backed reconciliation worker.
- Exercise restart, replay, duplicate delivery, cancellation, partial outage,
  disaster recovery, and multi-instance behavior.
- Add externally anchored append-only evidence, retention controls, and signed
  release artifacts.
- Publish an SBOM and build provenance; continuously run dependency, static,
  secret, and OpenSSF Scorecard checks.
- Define reproducible security and performance benchmarks with declared hardware,
  workloads, latency percentiles, concurrency, and failure budgets.

## Stable-release gates

A future 1.0 should not be declared until the project has, at minimum:

1. Two independently useful external adapters passing the full fidelity suite.
2. A documented stable contract and compatibility/migration policy.
3. Production-capable identity integration and target credential isolation.
4. Shared-state recovery, reconciliation, and externally anchored audit evidence.
5. A completed threat review plus independent security assessment or equivalent
   public evidence.
6. Reproducible performance and recovery reports with no use of the synthetic
   record count as a benchmark claim.
7. At least two independently attributable adopters or design partners and one
   non-maintainer contribution to an adapter or conformance suite.

## How to participate

Useful early contributions include:

- reviewing the canonical Contract Capsule and obligation vocabulary;
- proposing a target adapter with a native-control and read-back mapping;
- adding deny, degradation, rollback, and drift cases to the conformance suite;
- integrating an existing PDP or relationship store without duplicating it; and
- documenting a reproducible enterprise access-isolation scenario using only
  synthetic data.

Start with [CONTRIBUTING.md](CONTRIBUTING.md), search existing
[issues](https://github.com/mkbhardwas12/purposemesh/issues), and open a design
discussion before implementing a new adapter or policy-model surface.

## Explicit non-goals for the preview

- Claiming universal target support from compiler previews.
- Replacing identity providers, IGA suites, OPA, Cedar, OpenFGA, SpiceDB, Ranger,
  or a target's native security model.
- Treating UI visibility as an authorization boundary.
- Learning permissions from observed user behavior or inferring missing policy.
- Describing the 100,000-record synthetic fixture as a capacity limit,
  throughput result, or production benchmark.
