# Security policy

This policy covers PurposeMesh, the reference implementation for purpose-bound
access enforced across application and data boundaries.

## Supported version

Security fixes are applied to the latest revision of `main`. This repository is
a reference implementation and does not claim production certification.

## Report a vulnerability privately

Use GitHub’s **Security → Report a vulnerability** flow for this repository.
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
private advisory.

## Safe-harbor intent

Good-faith research that avoids privacy violations, service disruption,
destructive actions, social engineering, and access beyond the minimum needed
to demonstrate the issue is welcome. Stop testing and report immediately if you
encounter real credentials or non-synthetic data.

For the implemented guarantees and known production gaps, read
[`docs/SECURITY.md`](../docs/SECURITY.md).
