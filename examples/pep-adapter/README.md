# PurposeMesh TypeScript PEP Adapter Example

> **TECHNICAL PREVIEW** — This local adapter demonstrates the PurposeMesh
> evaluation API and server-side field projection. It is **not** a full AuthZEN
> conformant implementation. Production deployment requires a conformant adapter
> with published, target-version-scoped passing evidence.

This example implements a TypeScript Policy Enforcement Point (PEP) that
integrates with PurposeMesh without treating UI visibility as authorization. All
authorization decisions are delegated to the PurposeMesh Policy Decision Point
(PDP), and data projection is performed server-side.

## What this example demonstrates

| Requirement | Implementation |
|---|---|
| Subject/action/resource/context evaluation | Sends requests to `POST /access/v1/evaluation` following the AuthZEN-shaped API |
| Missing, unknown, malformed, and unsupported obligations | Treated as deny — the PEP never interprets unrecognized obligation shapes |
| Server-side field projection | Fetches data from `GET /api/data/:datasetId` which returns only authorized fields |
| Request identifier propagation | Includes `x-request-id` header for tracing; never logs bearer tokens or sensitive records |
| Allow and deny test coverage | One allow test plus multiple deny/failure tests covering predicate miss, malformed responses, network errors, and unknown obligations |

## What this example does NOT provide

- **AuthZEN conformance** — This is a demonstration adapter, not a conformant
  implementation. Full conformance requires independent testing, published
  evidence, and version-scoped verification.
- **Enterprise authentication** — The adapter accepts a bearer token directly.
  Production use requires enterprise OIDC/BFF integration, not demo tokens.
- **Apply/revoke/read-back** — This adapter only reads authorization decisions.
  It does not provision, revoke, or verify enforcement at external targets.
- **Drift reconciliation** — No continuous comparison between PurposeMesh policy
  and target enforcement state.

## Running the example

Requirements: Node.js 24+ and npm 11+.

```bash
# From the repository root
npm ci

# Run the PEP adapter tests
npm run test -w @cca/pep-adapter-example

# Run all repository tests
npm run preflight
```

## Usage

```typescript
import { createPepAdapter } from "@cca/pep-adapter-example";

const adapter = createPepAdapter({
  baseUrl: "http://127.0.0.1:8787",
  bearerToken: token,
  requestId: crypto.randomUUID(),
});

// Low-level evaluation (returns PDP decision only)
const evalResult = await adapter.evaluate({
  subject: { id: "emma.acme", type: "user" },
  action: { name: "view" },
  resource: { id: "bw_vendor", type: "dataset" },
  context: { purpose: "vendor-performance" },
});

// Full enforcement (evaluates + fetches server-projected data)
const result = await adapter.enforceDataAccess({
  subject: { id: "emma.acme", type: "user" },
  action: { name: "view" },
  resource: { id: "bw_vendor", type: "dataset" },
  context: { purpose: "vendor-performance" },
});

if (result.effect === "deny") {
  console.log(`Access denied: ${result.reason}`);
} else {
  // result.records contains only server-projected fields
  for (const record of result.records) {
    console.log(record.attrs); // Only authorized fields present
  }
}
```

## Deny-by-default behavior

The adapter treats the following conditions as deny:

| Condition | Deny reason |
|---|---|
| Response missing `obligations` | `missing_obligations` |
| Obligations contain unrecognized keys | `unknown_obligation` |
| Response structure invalid | `malformed_response` |
| Network error | `network_error` |
| HTTP 403 | `subject_mismatch` |
| HTTP 404 on data fetch | `resource_unknown` |
| PDP returns `decision: false` | Maps known reasons; otherwise `evaluation_denied` |

Unknown obligation keys cause an immediate deny because the PEP cannot safely
enforce obligations it does not understand. This prevents silent
permission-widening if a future PurposeMesh version adds new obligation types.

## Server-side projection

The adapter does **not** filter fields locally. When `enforceDataAccess` is
called:

1. The PDP evaluates the request and returns obligations (including
   `allowedFields` and `denyFields`).
2. The adapter fetches data from the API, which performs server-side projection.
3. The response contains only the fields the subject is authorized to see.

This design prevents the common vulnerability where a client-side filter can be
bypassed by inspecting network traffic or manipulating the UI.

## Request identifier propagation

The adapter propagates a `requestId` in the `x-request-id` header for
distributed tracing. This identifier:

- Appears in deny results for correlation
- Is exposed on the adapter instance via `adapter.requestId`
- Is **never** logged alongside bearer tokens or sensitive record content

## Test coverage

The test suite (`pep-adapter.test.ts`) covers:

- **Allow path**: Authorized subject receives server-projected records
- **Deny paths**:
  - PDP denies access (predicate miss)
  - Resource not found
  - Malformed response
  - Unknown obligations
  - Network errors
  - Subject mismatch (403)

All tests use synthetic data and mock responses.

## License

Apache License 2.0 — see [LICENSE](../../LICENSE).
