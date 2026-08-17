# PurposeMesh API

The API has two explicit runtime modes:

- `CCA_MODE=demo` enables the seeded directory and password login for the local product demo.
- `CCA_MODE=production` disables the demo directory and password login. It requires `CCA_JWT_SECRET` with at least 32 characters, at least one exact origin in `CCA_CORS_ORIGINS`, a pre-provisioned control-plane snapshot, and an existing warehouse opened read-only.

Tests use the explicit `test` mode and an in-memory warehouse/control plane unless a repository is passed to `buildApp`.

## Production configuration

| Variable | Meaning | Default |
|---|---|---|
| `CCA_MODE` | `demo`, `test`, or `production` | `production` outside tests |
| `CCA_JWT_SECRET` | HS256 verification secret; required in production | none |
| `CCA_CORS_ORIGINS` | Comma-separated exact console origins | local Vite origins in demo |
| `CCA_CONTROL_DB` | Durable control-plane SQLite snapshot; must already exist and validate in production | `data/cca-control.sqlite` |
| `CCA_DB` | Warehouse SQLite database; must already exist and contain the required schema in production | `data/cca.sqlite` |
| `CCA_FACT_ROWS` | Generated demo/test warehouse row count (minimum 100,000); ignored by the production read-only path | `100000` |
| `HOST` / `PORT` | Listen address and port | `0.0.0.0:8787` in production |
| `CCA_LOG_LEVEL` | Fastify/Pino log level | `info` |
| `CCA_TRUST_PROXY` | Trust forwarding headers from a configured proxy | `false` |

`GET /api/health` is the process liveness check. `GET /api/ready` reads the warehouse and commits a timestamp to a dedicated control-plane readiness table. This verifies that the durable policy store is writable without changing authorization state. Neither unauthenticated endpoint discloses warehouse cardinality.

## Authorization workflow

All protected routes require signed tokens with `sub`, `exp`, `iat`, and `jti`, a positive lifetime of at most one hour, and an `iat` no more than 60 seconds in the future. Production tokens also require a canonical nonblank `purpose`; demo/test tokens may remain unscoped for local workflows. They revalidate the token subject against the current principal and reject disabled accounts or stale persona claims. Purpose-bearing PDP, data, dashboard, JIT, and non-admin role workflows require an exact token/request purpose match. Governance-only routes require `purpose=governance` when the token is purpose-bound.

No caller can directly apply roles. Requests use:

1. `POST /api/role-requests` with `{ draft, principalId? }`; non-admins can target only themselves.
2. `GET /api/role-requests`; users see their own requests, while active warehouse Data Owners and Governance Admins see the review queue.
3. `POST /api/role-requests/:id/approve` or `/deny`; a request requires one active Data Owner approval and one active Governance Admin approval from two distinct people. The first approval leaves the request pending, and only the second valid approval applies the role. Either reviewer may deny.

The requester and target cannot review the request. Creation fails when no distinct independent reviewer pair is available; one person cannot approve twice, reviewer authority is rechecked before final apply, and separation-of-duty rules are re-evaluated at request and approval time. `POST /api/roles/apply` is retained only as an explicit fail-closed compatibility endpoint: it always returns `409 approval_workflow_required`. The internal apply function is reached only after the approval policy completes. Preview responses contain aggregates only (`sample` is always empty); ordinary previews are intersected with the caller's current purpose-bound warehouse scopes.

The demo seeds `dana.owner`, `hugo.admin`, and `iris.admin` so both valid authorship paths are executable. A non-reviewer self-request uses Dana plus either independent admin. An admin-authored request for a non-admin target uses Dana plus the *other* admin; the author cannot approve it. Both administrators have control-plane membership and classification ceiling `none`, so reviewer availability adds no business-data access.

`POST /api/capsules/:capsuleId/members` cannot grant business or data access: both the route and the core lifecycle function return `approval_workflow_required` for every capsule except the explicit `control-plane` administrator-recovery path. Normal standing access must use the frozen role-request workflow above.

Catalog, JIT, role-request, palette, and access-explanation responses are scoped to the current principal and token purpose unless the caller is an authorized governance reviewer. Audit, compiler, control-plane recovery membership, offboarding, JIT administration, campaign creation/renewal, and reset require a Governance Admin with `purpose=governance` when scoped. Data Owners use `purpose=data-governance` for role decisions, SoD evidence, and eligible recertification decisions. Reset is unavailable in production.

The current governance policy is executable but reference-specific. Reviewer role `data-owner` means the exact `data-owner` persona in capsule `data-governance-owner`; Governance Admin means an exact admin persona with a live `control-plane` membership. Three versioned warehouse SoD rules are code constants, not tenant-configurable policy data. Production must resolve owners from affected resources and persist configurable, approved rule versions.

Recertification endpoints create, list, renew, attest, revoke, and export evidence for manual campaigns over active **human** memberships. Items capture the stable membership `assignmentId`; a removed/re-granted or otherwise changed assignment becomes `removed` instead of being attested under stale evidence. Self-review and last-admin removal are blocked. There is no scheduler or notifier. Expiry is refreshed lazily when a recertification endpoint is called, makes the campaign non-actionable, and does not revoke pending memberships. `cadenceDays` and `nextCampaignAt` do not schedule execution.

Warehouse samples use the dataset's explicit field allowlist first, then apply the conservative union of field denies across matching scopes. Matching scope allowlists are intersected; a missing, invalid, or empty projection returns no rows or aggregates. Only the explicit Data Owner contract receives global warehouse cardinality; every other identity, including Platform Admin, receives authorized counts only. Every preview is metadata-only: no record samples, monetary sums, or date/time series are returned.

## Durability and deployment boundary

The control-plane repository stores a validated `CcaStore` snapshot plus role-request approvals, JIT-request metadata, and recertification campaigns in SQLite using WAL, `synchronous=FULL`, and an atomic upsert transaction. API mutations snapshot both in-memory structures before applying a change and restore them if persistence fails, so an uncommitted authorization change cannot remain active in process. Applied roles, memberships and assignment ids, partial approvals, JIT grants, campaigns, and the audit sequence survive restart. Newly created demo/test SQLite files are restricted to owner read/write (`0600`) on POSIX systems. `buildApp` remains repository-optional for hermetic tests.

Demo and test modes may generate a warehouse and seed the bundled identities. Production does neither: `CCA_CONTROL_DB` must be an existing regular SQLite file containing a structurally and relationally valid snapshot, and `CCA_DB` must be an existing regular SQLite file with the required `facts` schema. The production warehouse connection is SQLite read-only, so startup never creates, drops, migrates, or reseeds warehouse tables. Provision both files through an approved, access-controlled deployment process, set ownership for the API service account, and do not promote the bundled demo identities as production policy.

The current control-plane store uses snapshot schema v3. Demo and test modes may automatically migrate a v2 snapshot only when its legacy JIT array is empty; that narrow migration backfills each membership's `personaId` from its referenced principal, appends a hash-chained `store.migrate.v2-v3` audit event, and immediately persists v3. Automatic migration fails closed when any legacy JIT state exists. Demo startup also performs an idempotent, audited refresh of only the built-in warehouse dataset/contracts and missing Data Owner fixtures, preserving custom roles and workflow state. Production never performs that seed refresh, always rejects v2 and older snapshots, and requires a reviewed offline migration; v1 remains intentionally unsupported.

This is an honest **single-node durability boundary**, not a multi-replica database. Run one API writer per `CCA_CONTROL_DB`. The snapshot includes the entire local audit chain and the whole JSON envelope is copied/serialized on persisted audited operations, so write cost grows with audit history. Its unkeyed local SHA-256 chain is tamper-evident only relative to the retained mutable snapshot; it is not an external immutable anchor.

`npm run ops:control-plane -- backup|verify|restore` provides WAL-consistent backup, production-parser validation, hashes/object counts, transactional restore, and a verified rollback bundle for an existing target. Every existing source, bundle, target, rollback, WAL, and SHM path component is checked with `lstat` and symlinks are rejected. This is verified local recovery only. Production still needs encrypted offsite replication, independent retention/legal hold, external signed/WORM audit checkpoints, automated restore exercises, and regional recovery. See the [backup and restore runbook](../../docs/runbooks/control-plane-backup-restore.md).

The next state step is PostgreSQL with migrations, row-level constraints, optimistic concurrency, normalized append-only audit storage, and an outbox-backed reconciler before horizontally scaling the API. The compiler endpoints return desired policy artifacts; they do not claim to have changed SAP, BW, BOBJ, or Elasticsearch. Elasticsearch previews use `<sanitized-dataset-id>-<12-character-SHA-256-prefix>-*`, not an unhashed `{dataset}-*`, so sanitized identifier collisions remain separated.

The React console stores the bearer token in tab-scoped `sessionStorage`, deletes the legacy `localStorage` token, warns before expiry, and clears expired/401 sessions. Each signed token includes a required 64-hex authorization fingerprint derived from exact live membership assignment ids, personas, and capsules; the API recomputes it on every protected request, so removal and same-capsule re-grant cannot revive an old token. The API emits `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`; `apps/web/index.html` installs a baseline document-level CSP for the local static entry point. Treat this as a local client boundary, not enterprise session management: same-origin JavaScript can still read the token, and production should deliver a tested CSP as an HTTP header while using OIDC through a BFF, `HttpOnly`/`Secure`/`SameSite` cookies, and server-side refresh/session revocation. See the [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) and [CSP](https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html) guidance.

The API contract and governance design are grounded in the [OpenID AuthZEN Authorization API 1.0](https://openid.net/specs/authorization-api-1_0.html), [NIST RBAC](https://csrc.nist.gov/Projects/role-based-access-control/faqs), [NIST ABAC SP 800-162](https://csrc.nist.gov/pubs/sp/800/162/upd2/final), and [NIST SP 800-53 Rev. 5](https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final). These references guide the model; they are not a conformance certification.

## Verification

```bash
npm run test -w @cca/api
npm run typecheck -w @cca/api
npm run build -w @cca/api
```
