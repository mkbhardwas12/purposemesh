/**
 * Policy Enforcement Point Adapter Tests
 *
 * These tests demonstrate PEP integration with PurposeMesh using synthetic data.
 * They verify:
 * - Allow path: authorized subject receives server-projected records
 * - Deny paths: unauthorized subjects, malformed responses, and missing obligations
 * - Request identifier propagation without logging bearer tokens or sensitive data
 *
 * TECHNICAL PREVIEW — This adapter is not a full AuthZEN conformant implementation.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createPepAdapter, type PepAdapter } from "./pep-adapter.js";
import type { DenyResult, EvaluationDecision, EvaluationRequest } from "./types.js";

const SYNTHETIC_ALLOW_RESPONSE: EvaluationDecision = {
  decision: true,
  context: {
    reason: "contract_allow",
    obligations: {
      allowedFields: ["vendor_id", "vendor_name", "region", "spend"],
      denyFields: [],
      contractIds: ["vendor.acme.slice"],
      capsuleIds: ["vendor-acme"],
    },
  },
};

const SYNTHETIC_DATA_RESPONSE = {
  decision: { effect: "allow", reason: "contract_allow" },
  records: [
    {
      id: "bw-1",
      datasetId: "bw_vendor",
      classification: "confidential",
      attrs: { vendor_id: "V1001", vendor_name: "ACME Supplies", region: "NA" },
      contractId: "vendor.acme.slice",
      capsuleId: "vendor-acme",
    },
    {
      id: "bw-2",
      datasetId: "bw_vendor",
      classification: "confidential",
      attrs: { vendor_id: "V1002", vendor_name: "ACME Logistics", region: "EU" },
      contractId: "vendor.acme.slice",
      capsuleId: "vendor-acme",
    },
  ],
};

const SYNTHETIC_DENY_RESPONSE: EvaluationDecision = {
  decision: false,
  context: {
    reason: "predicate_miss",
    obligations: {
      allowedFields: [],
      denyFields: [],
      contractIds: [],
      capsuleIds: [],
    },
  },
};

const VALID_REQUEST: EvaluationRequest = {
  subject: { id: "emma.acme", type: "user" },
  action: { name: "view" },
  resource: { id: "bw_vendor", type: "dataset" },
  context: { purpose: "vendor-performance" },
};

describe("PEP Adapter - Technical Preview", () => {
  let adapter: PepAdapter;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    adapter = createPepAdapter({
      baseUrl: "http://127.0.0.1:8787",
      bearerToken: "test-token-synthetic",
      requestId: "req-12345",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("evaluate()", () => {
    it("returns allow decision with obligations when PDP permits access", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => SYNTHETIC_ALLOW_RESPONSE,
      });

      const result = await adapter.evaluate(VALID_REQUEST);

      expect(fetchMock).toHaveBeenCalledWith(
        expect.objectContaining({ href: "http://127.0.0.1:8787/access/v1/evaluation" }),
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            authorization: "Bearer test-token-synthetic",
            "x-request-id": "req-12345",
          }),
        }),
      );

      expect("decision" in result && result.decision).toBe(true);
      expect(result).toMatchObject({
        decision: true,
        context: {
          reason: "contract_allow",
          obligations: {
            allowedFields: expect.arrayContaining(["vendor_id", "vendor_name"]),
            contractIds: ["vendor.acme.slice"],
            capsuleIds: ["vendor-acme"],
          },
        },
      });
    });

    it("returns deny with reason when PDP denies access (predicate miss)", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => SYNTHETIC_DENY_RESPONSE,
      });

      const result = await adapter.evaluate(VALID_REQUEST);

      expect("effect" in result && result.effect === "deny").toBe(true);
      expect((result as DenyResult).reason).toBe("predicate_miss");
      expect((result as DenyResult).requestId).toBe("req-12345");
    });

    it("returns deny when response is malformed (missing obligations)", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          decision: true,
          context: { reason: "contract_allow" },
        }),
      });

      const result = await adapter.evaluate(VALID_REQUEST);

      expect("effect" in result && result.effect === "deny").toBe(true);
      expect((result as DenyResult).reason).toBe("malformed_response");
    });

    it("returns deny when obligations contain unknown keys", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          decision: true,
          context: {
            reason: "contract_allow",
            obligations: {
              allowedFields: ["vendor_id"],
              denyFields: [],
              contractIds: [],
              capsuleIds: [],
              unknownFutureObligation: "should_fail_closed",
            },
          },
        }),
      });

      const result = await adapter.evaluate(VALID_REQUEST);

      expect("effect" in result && result.effect === "deny").toBe(true);
      expect((result as DenyResult).reason).toBe("unknown_obligation");
    });

    it("returns deny on network error", async () => {
      fetchMock.mockRejectedValueOnce(new Error("Connection refused"));

      const result = await adapter.evaluate(VALID_REQUEST);

      expect("effect" in result && result.effect === "deny").toBe(true);
      expect((result as DenyResult).reason).toBe("network_error");
    });

    it("returns deny on 403 (subject mismatch)", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ error: "admin_required" }),
      });

      const result = await adapter.evaluate(VALID_REQUEST);

      expect("effect" in result && result.effect === "deny").toBe(true);
      expect((result as DenyResult).reason).toBe("subject_mismatch");
    });
  });

  describe("enforceDataAccess()", () => {
    it("returns server-projected records when authorized (allow path)", async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: async () => SYNTHETIC_ALLOW_RESPONSE,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => SYNTHETIC_DATA_RESPONSE,
        });

      const result = await adapter.enforceDataAccess(VALID_REQUEST);

      expect(result.effect).toBe("allow");
      if (result.effect === "allow") {
        expect(result.records).toHaveLength(2);
        expect(result.records[0]?.attrs).toMatchObject({
          vendor_id: "V1001",
          vendor_name: "ACME Supplies",
        });
        expect(result.obligations.allowedFields).toContain("vendor_id");
        expect(result.obligations.contractIds).toContain("vendor.acme.slice");
      }
    });

    it("returns deny when evaluation is denied (deny path - predicate miss)", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => SYNTHETIC_DENY_RESPONSE,
      });

      const result = await adapter.enforceDataAccess(VALID_REQUEST);

      expect(result.effect).toBe("deny");
      if (result.effect === "deny") {
        expect(result.reason).toBe("predicate_miss");
      }
    });

    it("returns deny when data fetch fails (deny path - resource unknown)", async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: async () => SYNTHETIC_ALLOW_RESPONSE,
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          text: async () => JSON.stringify({ error: "not found" }),
        });

      const result = await adapter.enforceDataAccess(VALID_REQUEST);

      expect(result.effect).toBe("deny");
      if (result.effect === "deny") {
        expect(result.reason).toBe("resource_unknown");
      }
    });

    it("returns deny on malformed data response", async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: async () => SYNTHETIC_ALLOW_RESPONSE,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ unexpected: "structure" }),
        });

      const result = await adapter.enforceDataAccess(VALID_REQUEST);

      expect(result.effect).toBe("deny");
      if (result.effect === "deny") {
        expect(result.reason).toBe("malformed_response");
      }
    });
  });

  describe("request identifier propagation", () => {
    it("propagates request identifier in evaluation headers", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => SYNTHETIC_ALLOW_RESPONSE,
      });

      await adapter.evaluate(VALID_REQUEST);

      expect(fetchMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({
            "x-request-id": "req-12345",
          }),
        }),
      );
    });

    it("includes request identifier in deny results for tracing", async () => {
      fetchMock.mockRejectedValueOnce(new Error("Network error"));

      const result = await adapter.evaluate(VALID_REQUEST);

      expect("effect" in result && result.effect === "deny").toBe(true);
      expect((result as DenyResult).requestId).toBe("req-12345");
    });

    it("exposes request identifier on adapter instance", () => {
      expect(adapter.requestId).toBe("req-12345");
    });
  });

  describe("obligation validation", () => {
    it("accepts valid obligations with policyVersion", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          decision: true,
          context: {
            reason: "jit_allow",
            obligations: {
              allowedFields: ["vendor_id"],
              denyFields: ["spend"],
              contractIds: ["wh.l2-bw"],
              capsuleIds: ["support-l2-bw"],
              policyVersion: "v3.2.0-20260101",
            },
          },
        }),
      });

      const result = await adapter.evaluate(VALID_REQUEST);

      expect("decision" in result && result.decision).toBe(true);
    });

    it("rejects obligations with invalid allowedFields type", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          decision: true,
          context: {
            reason: "contract_allow",
            obligations: {
              allowedFields: "not_an_array",
              denyFields: [],
              contractIds: [],
              capsuleIds: [],
            },
          },
        }),
      });

      const result = await adapter.evaluate(VALID_REQUEST);

      expect("effect" in result && result.effect === "deny").toBe(true);
      expect((result as DenyResult).reason).toBe("malformed_response");
    });
  });
});
