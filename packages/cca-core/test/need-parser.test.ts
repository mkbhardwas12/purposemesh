import { describe, expect, it } from "vitest";
import { parseNeedToRole } from "../src/need-parser.js";

describe("parseNeedToRole", () => {
  it("parses L1 SAP process-chain health without vendor PII", () => {
    const { draft, rationale } = parseNeedToRole(
      "L1 support should see process chain health but not vendor PII",
    );
    expect(draft.verbs).toContain("view");
    expect(draft.purpose).toBe("support");
    expect(draft.products).toEqual(["process_chains"]);
    expect(draft.ceiling).toBe("internal");
    expect(draft.sources).toEqual(["sap"]);
    expect(draft.denyFields).toEqual(
      expect.arrayContaining(["payload", "vendor_id", "legal_name", "email"]),
    );
    expect(rationale.join(" ")).toMatch(/process_chains/);
  });

  it("parses a generic ACME finance slice", () => {
    const { draft } = parseNeedToRole("ACME finance team only NA transactions");
    expect(draft.purpose).toBe("finance");
    expect(draft.products).toEqual(["transactions"]);
    expect(draft.tenants).toEqual(["ACME"]);
    expect(draft.regions).toEqual(["NA"]);
    expect(draft.departments).toEqual(["finance"]);
    expect(draft.ceiling).toBe("confidential");
    expect(draft.sources).toEqual(["generic"]);
  });

  it("parses observability ES/pipeline logs with payload stripped", () => {
    const { draft } = parseNeedToRole(
      "observability can see ES/pipeline logs with payload stripped",
    );
    expect(draft.purpose).toBe("operations");
    expect(draft.products).toEqual(expect.arrayContaining(["es_logs"]));
    expect(draft.ceiling).toBe("internal");
    expect(draft.denyFields).toContain("payload");
    expect(draft.sources).toEqual(expect.arrayContaining(["sap"]));
  });

  it("covers mixed SAP and generic asks", () => {
    const { draft } = parseNeedToRole(
      "GLOBEX EU team needs BW vendor analytics and customer tickets, no bank accounts",
    );
    expect(draft.tenants).toEqual(["GLOBEX"]);
    expect(draft.regions).toEqual(["EU"]);
    expect(draft.products).toEqual(expect.arrayContaining(["bw_vendor", "customers", "tickets"]));
    expect(draft.sources).toEqual(expect.arrayContaining(["sap", "generic"]));
    expect(draft.denyFields).toEqual(expect.arrayContaining(["account_number", "bank_account"]));
  });
});
