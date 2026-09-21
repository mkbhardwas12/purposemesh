# Security policy

This policy covers PurposeMesh, the reference implementation for purpose-bound
access enforced across application and data boundaries.

## Supported version

Security fixes are applied to the latest revision of `main`. This repository is
a reference implementation and does not claim production certification.

## Report a vulnerability privately

Use [GitHub’s private vulnerability reporting form](https://github.com/mkbhardwas12/purposemesh/security/advisories/new)
for this repository (**Security → Report a vulnerability**). Private vulnerability
reporting is enabled; reports are not public issues.
Do not disclose a suspected vulnerability in a public issue, pull request,
discussion, screenshot, or demo recording.

Include, when possible:

- affected commit and component;
- preconditions and a minimal synthetic-data reproduction;
- expected versus observed authorization behavior;
- impact, including rows, fields, actions, purposes, or identities affected; and
- suggested remediation or compensating controls.

You should receive an acknowledgement within five business days. Validation,
remediation, disclosure timing, and credit will be coordinated through the
private advisory. If the reporting form is unavailable, follow
[GitHub’s private-reporting instructions](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
and wait for the private channel to become available; do not post exploit details
publicly as a workaround.

## Safe-harbor intent

Good-faith research that avoids privacy violations, service disruption,
destructive actions, social engineering, and access beyond the minimum needed
to demonstrate the issue is welcome. Stop testing and report immediately if you
encounter real credentials or non-synthetic data.

For the implemented guarantees and known production gaps, read
[`docs/SECURITY.md`](../docs/SECURITY.md).
