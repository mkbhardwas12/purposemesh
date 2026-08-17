# PurposeMesh security model

**Purpose-bound access, enforced everywhere.**

PurposeMesh is an authorization control plane. Authentication establishes the caller;
authorization decides whether that caller may perform one action on one resource
for a trusted purpose and context. A successful login, Platform Admin
persona, compiler preview, dashboard filter, or group name is never sufficient
authority by itself.

The current repository proves local policy behavior. It does not prove external
SAP, BW, Elasticsearch, ADF, warehouse-native, or BI enforcement because those
connectors are not present.

## Security objectives

1. Default deny and complete mediation across API, direct query, export,
   dashboard, search, pipeline, preview, and administrative paths.
2. Five stable capability personas—Viewer, Operator, Data Steward, Security
   Auditor, and Platform Admin—without role explosion.
3. Tenant, team, row, field, classification, purpose, and time isolation.
4. Management-plane administration separated from business-data access.
5. Human and workload identities with least privilege and rapid revocation.
6. No silent loss of policy fidelity at a target.
7. Verifiable onboarding, access change, JIT, and offboarding lifecycle.
8. Explainable decisions and tamper-evident evidence, with external retention and
   anchoring required for production.

No system can honestly be described as impossible to compromise. PurposeMesh's target is
to reduce likelihood and blast radius, detect drift, fail safely, and revoke
quickly, with claims backed by tests and measured service levels.

## Non-bypassable policy invariants

1. Unknown, disabled, expired, stale, or time-invalid subjects are denied.
2. A data decision requires an active principal, an active capsule/relationship,
   an allowed action, exact trusted purpose, a registered resource, applicable
   contract or bounded JIT grant, and complete context.
3. Missing purpose, scope, resource, field allowlist, classification, or required
   target capability is a denial; absence can never widen access.
4. A mandatory tenant boundary is derived from trusted identity and resource
   metadata. A client-supplied tenant/team value is never authoritative.
5. Both the contract classification maximum and persona/subject clearance must
   cover the actual dataset and record.
6. Row predicates are evaluated server side or compiled for a PEP by a conformant
   adapter with published, target-version-scoped passing evidence. A UI,
   workbook, URL parameter, hidden sheet, or client calculation is not security.
7. Data projection is allow-first. Denies and masks are additional restrictions;
   an absent or invalid allowlist releases no fields.
8. Each access capsule is atomic: its row predicate and field projection remain
   coupled. Multiple grants cannot be flattened into a wider row/column
   cross-product.
9. Explicit deny, inactive team/capsule, expired JIT, and global classification
   guards take precedence over allows. Expiring standing leases are a production
   target, not a current repository capability.
10. Platform Admin authorizes the management plane only. Business data requires
    a separate Viewer/Operator data capsule; break-glass is temporary and
    approved. Data Steward and Security Auditor likewise receive no implicit raw
    business-data access.
11. Preview never grants authority. Non-governance users may preview only current
    effective metadata; sensitive samples, monetary sums, and time series are not
    returned during access authoring.
12. Authoring, approval, apply, and restricted-data use are separately auditable.
    A standing-access request is not applied until two distinct eligible reviewers
    have supplied the required `data-owner` and `governance-admin` approvals. A
    requester or target cannot approve their own elevation, and one identity
    cannot satisfy both approval roles.
13. A compiler or adapter fails closed when canonical semantics cannot be
    reproduced exactly. Generated JSON is not target proof.
14. A policy becomes externally active only after target read-back matches the
    approved version. Drift moves the target to a degraded/noncompliant state.
15. If durable persistence rejects a mutation, in-memory policy, API workflow
    metadata, and audit sequence are restored before returning the error.
16. Security events include subject, resource, action, purpose, decision, reason,
    policy version, obligations, lifecycle correlation, and target evidence, and
    are retained outside mutable application state in production.

## Current AuthZEN evaluation boundary

`POST /access/v1/evaluation` is a minimal reference adapter over the canonical
PDP, not a separate policy engine. Its JSON schema rejects extra properties. A
normal caller can evaluate only the authenticated subject; cross-subject checks
require a governance-capable Platform Admin. Self-evaluation purpose is checked
against the verified token; a scoped cross-subject token must be
governance-scoped. An optional record id is resolved against the named dataset
server side, unknown/mismatched resources deny, and every outcome is audited. An
allow returns the field allow/deny lists and contract/capsule identifiers that
the application PEP must enforce before releasing data.

This endpoint currently covers canonical actions and dataset resources with purpose and
optional record context. Broader resource types, richer obligations, PEP SDKs,
formal conformance evidence, and production identity integration remain target
work.

## Correct JIT semantics

JIT is a short-lived alternative authorization envelope, not a bypass around
standing row and classification controls.

### Request and approval

- Requester and target principal are the same in the current self-service flow.
- Principal and capsule must be live and the principal must already be a capsule
  member.
- Purpose exactly matches the capsule purpose.
- Requested actions are known and already permitted by the subject's functional
  persona.
- The request resolves exactly one predeclared `approvalRequired` contract bound
  to the live capsule and allowed persona (or supplies its id if several are
  eligible). The grant freezes that contract's predicate and capsule attributes
  and is bound to one principal, dataset, capsule, purpose, action set, explicit
  field allowlist/denies, classification maximum, policy version, and assurance
  context.
- The approver is a different active control-plane Platform Admin.
- Approval cannot widen the requested rows, fields, class, actions, purpose, or
  duration. It may reduce them.
- TTL is positive, bounded, and auto-expires; production policy should choose a
  shorter risk-based maximum for restricted data.

### Evaluation

At each use, the PDP must recheck:

```text
live principal
AND live capsule membership
AND matching principal + dataset + capsule + purpose + action
AND approved + not-before + not-expired
AND persona still permits action
AND actual dataset/record <= JIT classification maximum
AND actual record satisfies the JIT row predicate/DataScope
AND released fields are dataset allowlist INTERSECT JIT allowlist
AND JIT denies/masks still apply
```

If a bounded predicate cannot be constructed, JIT is denied. A dataset-wide JIT
grant is allowed only when the approved predicate is explicitly `true`, the
classification ceiling covers it, and the approval policy permits that breadth.

Membership removal, capsule offboarding, principal disablement, explicit
revocation, or expiry invalidates the grant immediately in the online PDP. Native
target revocation is not complete until the adapter removes and reads back the
external grant.

### Regression requirement

The critical negative tests use multi-vendor data: JIT for an ACME-scoped L2
user returns only the frozen ACME vendor set and never GLOBEX, even after the
live capsule attributes change. A seeded restricted S/4 JIT template does not
exist; an unconfigured request fails for lack of an approval-required contract,
and a test-injected restricted template fails at request because the dataset is
above the L2 confidential ceiling. The same tests must cover row predicates,
classification ceilings, fields, and revocation at the core PDP, API, SQL path,
and every conformant target adapter's published, version-scoped test suite.

## Governed standing-access changes

Role Studio is request-only. `POST /api/role-requests` records the draft and its
frozen review evidence; `POST /api/roles/apply` deliberately returns
`approval_workflow_required` and never provides a direct-assignment bypass.
Every request requires the exact approval roles `data-owner` and
`governance-admin`:

- the request is accepted only when two independent, eligible reviewers exist
  after excluding the requester and target principal;
- the first valid approval is persisted as a partial approval and grants no
  access;
- the same reviewer id, requester, target, or duplicate approval role cannot
  complete the pair;
- reviewer authority, target state, request evidence, and separation-of-duty
  findings are checked again before the second approval applies the assignment;
- reject and stale-review paths leave the requested access unapplied.

The demo seeds one Data Owner and two zero-business-data Governance Admins so
both supported authorship patterns can be tested. A non-reviewer self-request is
reviewed by the Data Owner plus either admin. An admin-authored request for a
non-admin target is reviewed by the Data Owner plus the other admin; the author
cannot approve it.

The local separation-of-duty policy is executable and versioned, but deliberately
small and demo-specific. It rejects a warehouse role that combines operation of
`s4_master` with operation of `transactions`, combines `audit` purpose with
`operate`, or combines `data-governance` purpose with `operate`. Evaluation uses
both standing access and the candidate request. The local data-owner reviewer is
also a seeded `data-owner` persona in the `data-governance-owner` capsule. These
are not a generic owner registry or configurable enterprise rules engine;
production must derive owners from governed catalog relationships and manage
versioned, organization-specific conflict rules.

The current recertification flow is manual and covers active human memberships
only. A campaign snapshots an assignment id plus principal, capsule, persona, and
membership fingerprint so an attestation or revocation addresses the reviewed
assignment rather than whichever membership happens to exist later. A reviewer
cannot certify their own assignment, and revocation retains the last-admin
safeguard. There is no scheduler, notification service, workload-membership
review, or automatic consequence for overdue access: campaign status is refreshed
when a recertification endpoint is read, and an overdue campaign becomes expired
without revoking pending memberships. Production must define and automate those
consequences explicitly.

## Authentication boundary

### Current repository

- Demo mode has seeded scrypt password verification and a shared demonstration
  password.
- Production mode disables demo login/directory/reset and validates a strict
  HS256 bearer-token contract intended for an upstream broker.
- Tokens require the expected algorithm, issuer, audience, subject, expiry,
  issued-at time, unique token id, purpose, positive lifetime, bounded maximum
  lifetime, acceptable clock skew, and a validated authentication-assurance value
  (`password`, `mfa`, or `phishing-resistant`).
- Tokens also require a 64-hex authorization fingerprint over the exact live
  membership assignment ids, personas, and capsules. Each protected request
  reloads current principal/persona state and recomputes the fingerprint; stale
  persona, principal-kind, removed-assignment, and remove/re-add claims are
  rejected.
- The API derives JIT request and approval assurance from the verified token. It
  does not accept an assurance claim from the JIT request body. The upstream
  issuer is still responsible for actually establishing that assurance.
- The browser keeps the demo bearer token in tab-scoped `sessionStorage`, removes
  legacy `localStorage` state, warns shortly before expiry, and clears protected
  state on expiry, 401, or account switch. This reduces persistence across tabs
  and restarts but remains JavaScript-readable bearer-token storage.
- API responses set cache and MIME/referrer hardening headers, and the local HTML
  entry point installs a baseline document-level CSP. Production still requires
  a tested CSP response header and a non-JavaScript-readable BFF session.

This is not enterprise SSO. The repository has no OIDC authorization flow, SCIM,
WebAuthn, DPoP/mTLS token binding, managed identity, SPIFFE issuance, certificate
rotation, or HR connector.

### Production target

- Human sessions: enterprise OIDC/BFF, Authorization Code + PKCE, exact redirect
  matching, phishing-resistant MFA, step-up for governance/export/break-glass,
  short sessions, rapid refresh/session revocation, an `HttpOnly`, `Secure`,
  appropriately `SameSite` cookie, CSRF protection, and a restrictive tested CSP.
- Workloads: unique managed identity or SPIFFE/SPIRE short-lived X.509 identity
  per pipeline/data product. Legacy SAP communication identities are narrow,
  owned, vaulted, rotated, and never reused by humans.
- Bearer tokens are short lived, audience-bound, and sender-constrained where
  supported. Authorization continues to use current server-side state.
- Network location alone never grants trust.

## Fidelity firewall

The current local compiler calculates deterministic policy hash/version,
currently eligible assignments, and required/supported/missing capability gates.
A native-shaped artifact may be returned for preview, but a missing row, field,
purpose, classification, or workload-identity capability marks deployment
blocked and `previewOnly`, with apply/revoke/read-back arrays left empty. No
connector executes anything, no installed target version is discovered, and no
external state is read back in this repository.

Elasticsearch preview index patterns are
`<sanitized-dataset-id>-<12-character-SHA-256-prefix>-*`. The native-id helper
normalizes with NFKC, replaces unsafe characters, bounds length, and appends the
hash prefix so two source identifiers that sanitize alike do not silently share
a pattern. It is still preview output until an adapter applies and reads it back
and publishes passing evidence scoped to that target version.

Each target capability is classified as `native`, `gateway`, `projection`, or
`unsupported` for:

- resource and action;
- row predicate operators;
- field projection and role-combination semantics;
- masking transformations;
- purpose and JIT enforcement;
- revocation propagation;
- decision/use/read-back audit.

If the complete policy cannot be represented natively, use a trusted gateway. If
that cannot enforce it, create an isolated view, index, schema, or data product.
Otherwise block the deployment. Warnings and best-effort translation are not
acceptable for authorization.

## Threat model

| Threat | Consequence | Required mitigation |
|---|---|---|
| UI/dashboard-only filter | Direct query exposes another team | Server/store/semantic-model PEP on every path |
| Shared pipeline service account | Credential compromise exposes all sources/targets | Unique managed/workload identity and least privilege |
| Stale employee or team membership | Former member retains access | SCIM event, online inactive guard, short session, leases, target reconciliation |
| Multiple roles widen rows/fields | Cross-team data through union semantics | Atomic envelopes, conservative composition, isolated projections when needed |
| JIT bypasses predicate/class ceiling | Temporary grant becomes dataset-wide | JIT-bound predicate and class re-evaluated per record |
| Admin implicitly reads data | Platform compromise becomes data compromise | Management/data separation; temporary independently approved data capsule |
| Classification lost during copy | Target releases source-restricted fields | Lineage label propagation and publish-time destination gate |
| Logs contain secrets or raw PII | Monitoring users exfiltrate payload | Pre-ingest sanitizer, prohibited-field detection, separate break-glass raw store |
| Client injects tenant/team/purpose | Horizontal privilege escalation | Derive trusted context server side and bind purpose to session/request |
| Compromised/replayed token | Impersonation | PKCE, MFA, short TTL, audience, sender constraint, rotation, revocation |
| PDP unavailable | Fail-open or broad stale decision | HA PDP, signed versioned cache, fail closed for high-risk paths |
| Target drift/manual grant | External state exceeds policy | Read-back, continuous reconciler, alert/quarantine, signed evidence |
| Aggregate/search inference | Restricted cohort existence is inferred | Minimum cohorts, pre-aggregation, query limits, or physical isolation |
| Policy/attribute poisoning | Attacker changes source facts | Provenance, schema validation, dual control, signed versions, independent audit |
| Cache key omits scope/version | One tenant receives another result | Include tenant, subject, resource, action, purpose, version, epoch, obligations |
| Superuser/owner bypasses native RLS | Target administrator reads protected rows | Remove standing ownership, segregate duties, test bypass roles, JIT break-glass |
| Connector partially applies policy | Inconsistent enforcement | Transactional/outbox workflow, idempotency, rollback, read-back before active |

## Platform-specific cautions

- **S/4HANA:** function authorization and CDS instance access are different
  controls. An extraction identity must not become a broad human query identity.
- **BW:** analysis authorization protects authorization-relevant characteristics;
  process-chain action authorization is separate. A custom governed query may be
  required for field-level log isolation.
- **Elasticsearch:** DLS/FLS is intended for read-only accounts, multiple roles can
  widen access, and some aggregate information can still leak. Use separate
  indexes for sensitive cohorts when required.
- **ADF:** Azure RBAC and managed identity protect orchestration and service
  access. ADF is not the row-level policy engine for interactive consumers; the
  source or destination must enforce data scope.
- **Warehouse:** validate RLS/CLS/masking semantics, owner/superuser bypass,
  exports, time travel, clones, and service-account paths.
- **Power BI:** RLS/OLS protects consumers, but Write/Contributor/Member/Admin
  access can bypass RLS. Keep production consumers read-only and segregate
  content creators.

These are target design requirements. No native target adapter is implemented in
the repository today.

## Lifecycle security

### Onboarding and change

1. Authoritative identity is active and attributes are fresh.
2. Manager/team and data-owner relationships are established.
3. Policy is simulated against representative positive and negative cases.
4. Separation-of-duty and conflict checks pass.
5. Assignment is time bounded or review dated.
6. Adapter applies desired state and reads it back.
7. Access becomes active only after verification.

In the current repository, direct business/data membership addition is
fail-closed in both the API and core lifecycle layer with
`approval_workflow_required`; only explicit control-plane administrator recovery
retains a direct-add operation. Standing business access must pass the frozen
two-reviewer request workflow.

### Offboarding

1. Mark principal/team/capsule inactive so online decisions deny.
2. Revoke sessions and update authorization epoch.
3. Remove memberships, bindings, JIT grants, and leases.
4. Remove or transfer workload identities and secrets.
5. Apply removal to every target.
6. Read each target back and prove zero residual grants.
7. Retain correlated completion evidence.

The current local offboard operation covers desired-state capsule deactivation,
membership/binding removal, JIT expiry, and pre-removal preview generation.
Blocked fidelity leaves no executable external revoke plan. It does not perform
or prove external revocation.

The current local recertification operation is narrower than this target. It is a
manual, human-membership-only campaign over exact assignment evidence. It has no
scheduler or notification connector, excludes workload memberships, and does not
revoke merely because a pending item becomes overdue.

## Availability and failure behavior

The current SQLite snapshot supports one API writer. Demo/test may auto-migrate
v2→v3 only when no legacy JIT exists and every membership persona resolves from
validated principals; production rejects v2 for reviewed offline migration.
Successful local migration is itself audited.

The repository has a verified single-node backup/restore path for the control
snapshot. Backup uses SQLite's online backup behavior, verifies the copy with the
production snapshot parser, and writes a manifest containing hashes and counts.
Restore revalidates the bundle, swaps it transactionally, and creates a rollback
bundle. Path components are checked and symbolic links are rejected. This is a
tested local recovery control, not offsite, immutable, encrypted, multi-region, or
point-in-time disaster recovery.

Each persisted audited operation currently serializes one complete JSON snapshot,
including the growing audit array. Storage and write work therefore grow with
history (`O(N)` in accumulated snapshot size). The in-process hash chain detects
accidental edits relative to the retained head, but a writer able to replace the
whole mutable snapshot can truncate or recompute it. The backup manifest beside a
backup is an integrity check, not an external immutable audit anchor.

Production robustness requires:

- stateless API/PDP replicas across failure domains;
- transactional shared store with constraints and optimistic concurrency;
- outbox-backed connector work so policy mutation and delivery cannot diverge;
- signed immutable versions and a tested last-known-good policy path;
- external append-only audit and target-evidence store;
- bounded caches keyed by policy version and authorization epoch;
- fail closed for restricted reads, writes, exports, JIT, and governance;
- connector lag and drift surfaced in readiness, not hidden behind liveness;
- offsite/encrypted backup, point-in-time restore, key rotation, dependency
  failure, and regional recovery tests.

Do not claim a decision, availability, or offboarding SLA until it is measured
against the production IdP, data size, network, and target systems.

## Required release evidence

### Local reference release

- Repository-wide typecheck, unit/integration tests, and production builds.
- Negative authorization tests for every protected route.
- Cross-vendor standing and JIT row/field/classification isolation.
- Persistence failure rollback and restart recovery.
- Dual-review partial/final approval, direct-apply denial, standing-plus-candidate
  SoD, exact-assignment recertification, and last-admin negative tests.
- Online backup integrity, restore rollback, malformed bundle, and symlink-path
  rejection tests.
- Token validation, stale-subject, purpose, admin-boundary, and self-approval
  negative tests.
- Dependency audit at the agreed severity threshold.

### Production adapter release

- Capability manifest for the exact platform version/edition.
- Golden compile tests and malformed/unrepresentable-policy denials.
- Plan/apply/revoke idempotency.
- Read-back, drift, retry, rollback, and partial-failure tests.
- Canonical-PDP versus native-target differential tests using the same dataset and
  principals.
- Direct-query, export, clone, aggregate, owner/admin, and alternate-path tests.
- Measured decision latency, revocation latency, connector lag, recovery, and
  load limits.
- Threat-model review and independent penetration/red-team testing.

Current local test success is evidence only for the local code paths covered by
those tests. It is not evidence that a preview compiler document secures a real
target.

## Primary security references

- [NIST RBAC model](https://csrc.nist.gov/Projects/role-based-access-control/faqs)
- [NIST SP 800-162, Attribute Based Access Control](https://csrc.nist.gov/pubs/sp/800/162/upd2/final)
- [NIST SP 800-207, Zero Trust Architecture](https://csrc.nist.gov/pubs/sp/800/207/final)
- [NIST SP 800-53 Rev. 5, including Update 1](https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final)
- [OpenID AuthZEN Authorization API 1.0](https://openid.net/specs/authorization-api-1_0.html)
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [OWASP Content Security Policy Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html)

Recorded local gate on 16 August 2026: all typechecks and production builds
passed; 57 core, 84 API, and 55 web tests passed (196 total). There were no known
vulnerabilities reported by `npm audit` on 16 August 2026 in the complete and
production-only dependency scans. This is point-in-time dependency evidence,
not proof that the application or future integrations are vulnerability-free.

Do not include credentials, production policy exports, customer data, secrets,
tokens, or raw restricted logs in bug reports. Use the organization's approved
confidential security-reporting channel.
