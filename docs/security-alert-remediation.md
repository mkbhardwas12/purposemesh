# Security-alert remediation — September 2026

This report maps remediation work to security dashboard findings on the public
default branch; it does not claim that every alert is closed. A pull-request
fix is not a default-branch fix until it passes the protected pull-request
requirements, is merged, and is rescanned. No alerts are dismissed or suppressed
by this change.

## Finding-to-control mapping

| Finding | Remediation | Evidence / remaining gate |
| --- | --- | --- |
| 37 CodeQL missing-rate-limiting alerts (#2–38) | Root Fastify limiter plus verified-principal, expensive-read, mutation, and aggregate login budgets | API regression tests; CodeQL must scan the changed revision |
| Filesystem race (#39) | Exclusive atomic creation; no-follow opens and descriptor checks; trusted directory/sidecar validation; no check-then-create branch | SQLite path regression tests, persistence and recovery suites; trusted-host limitation documented |
| Polynomial regular expression (#1) | Linear role-name scanner with bounded output | Long-input, Unicode, and generated-equivalence tests |
| Vulnerabilities (#46) | Fastify 5.12.5, Vitest 4.1.11, fast-uri 4.2.1 and 3.1.8 locked; CI audits development dependencies too | Full and runtime-only npm audits; OSV/Scorecard must rescan the merged lockfile |
| Branch protection (#40) | Solo-maintainer policy requires pull requests, CI, CodeQL, dependency review, resolved conversations, and administrator enforcement; force pushes/deletion disabled; second-person and last-push approval not required | Verify live settings and fresh post-merge Scorecard results; review-related protection scores may remain lower without required human approval |
| Security policy (#41) | Direct private-reporting and reporting-help links in `.github/SECURITY.md` | Private reporting verified enabled; merged-policy rescan required |
| Fuzzing (#42) | Actual fast-check security properties in TypeScript; scheduled and PR CI with three reproducible seeds | Pinned Scorecard v5.5.0 supports this integration; bounded property testing, not coverage-guided or external certification |
| Code review (#43) | Protected pull requests and mandatory checks remain; independent human review is encouraged but optional under the solo-maintainer policy | No two-person enforcement is claimed. Historical unreviewed commits remain historical, and this finding may remain open; automated checks alone do not establish independent review |
| Maintained (#44) | Documented contributor/review workflow and recurring CI/security checks | Repository was created 2026-08-17; the under-90-day heuristic cannot be removed honestly by changing code. Continue real maintenance and reassess after the age window |
| OpenSSF Best Practices badge (#45) | Owner checklist below | Requires an owner-led, truthful external assessment; no badge is claimed |

## Reproduce locally

Use the committed lockfile and Node.js 24 with npm 11:

```sh
npm ci
npm run preflight
npm audit --audit-level=high
npm audit --omit=dev --audit-level=high
PURPOSEMESH_FUZZ_SEED=20260920 PURPOSEMESH_FUZZ_RUNS=3000 npm run test:fuzz -w @cca/core
PURPOSEMESH_FUZZ_SEED=73419 PURPOSEMESH_FUZZ_RUNS=3000 npm run test:fuzz -w @cca/core
PURPOSEMESH_FUZZ_SEED=-184924771 PURPOSEMESH_FUZZ_RUNS=3000 npm run test:fuzz -w @cca/core
```

The fuzz workflow retains failure output with the seed and minimized
counterexample. Its seven properties exercise 63,000 generated cases across
the three seeds. Passing tests and a clean dependency audit do not establish
production readiness or absence of all vulnerabilities.

## Owner actions that cannot be fabricated

1. Open or update the security pull request, inspect the diff and evidence, and
   satisfy the required CI, CodeQL, dependency-review checks, and conversation
   resolution requirements on its latest revision. Local passing tests do not
   replace the required GitHub checks. A second-person review is welcome but
   is not a merge requirement under the approved solo-maintainer policy.
2. Merge through the protected pull-request workflow once its requirements pass,
   then verify fresh CodeQL, Scorecard, and vulnerability results against the
   merge commit. Keep remaining findings tracked; do not bypass required checks,
   fabricate review evidence, or dismiss unresolved findings to reduce a count.
3. Start the [OpenSSF Best Practices assessment](https://www.bestpractices.dev/)
   under the maintainer's own identity. Review every applicable criterion and
   link concrete evidence: license, contribution process, working build/test
   instructions, vulnerability reporting, secure-development review, release
   practices, and maintained dependencies. Record unmet criteria as unmet; add
   a badge only after the service issues a real project identifier and status.
4. Keep substantive maintenance, reviewed changes, and repeatable releases.
   Reassess the age/history checks after the repository has enough genuine
   evidence; an older creation date alone is not proof of active maintenance.

## References and scope

- [Security model and deployment limitations](SECURITY.md)
- [Scorecard check definitions](https://github.com/ossf/scorecard/blob/main/docs/checks.md)
- [GitHub branch-protection documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- [CodeQL missing-rate-limiting query](https://codeql.github.com/codeql-query-help/javascript/js-missing-rate-limiting/)

PurposeMesh remains a technical preview. Process-local throttling, local SQLite
policy enforcement, and these scans do not establish enterprise SSO, distributed
availability, external SAP/BW/Elasticsearch enforcement, or independent security
certification.
