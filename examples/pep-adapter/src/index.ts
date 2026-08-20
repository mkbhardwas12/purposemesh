/**
 * PurposeMesh TypeScript Policy Enforcement Point Example
 *
 * TECHNICAL PREVIEW — This local adapter demonstrates the PurposeMesh evaluation
 * API and server-side field projection. It is not a full AuthZEN conformant
 * implementation. Production deployment requires a conformant adapter with
 * published, target-version-scoped passing evidence.
 *
 * This example implements:
 * - Subject/action/resource/context evaluation against the PurposeMesh PDP
 * - Server-side field projection (not client-side hiding)
 * - Missing, unknown, malformed, and unsupported obligations treated as deny
 * - Request identifier propagation without logging bearer tokens or sensitive data
 *
 * @module
 */

export * from "./types.js";
export { createPepAdapter, type PepAdapter } from "./pep-adapter.js";
