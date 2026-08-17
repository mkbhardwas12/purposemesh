import { describe, expect, it } from "vitest";
import { check, filterDataset, explainAccess } from "../src/pdp.js";
import { seedStore } from "../src/seed.js";
import { approveJit, offboardCapsule, requestJit } from "../src/lifecycle.js";
import { compileCapsule } from "../src/compiler.js";
import { evalPredicate } from "../src/predicate.js";
import { verifyPassword } from "../src/crypto.js";

function vendorIds(rows: { attrs: Record<string, unknown> }[]): string[] {
  return rows.map((r) => String(r.attrs.vendor_id)).sort();
}

describe("seed landscape", () => {
  it("uses the shared demo password", () => {
    const store = seedStore();
    const emma = store.principals.get("emma.acme");
    expect(emma).toBeTruthy();
    expect(verifyPassword("cca-demo", emma!.passwordHash)).toBe(true);
    expect(verifyPassword("wrong", emma!.passwordHash)).toBe(false);
  });

  it("uses explicit allow-first field contracts for every warehouse role", () => {
    const store = seedStore();
    const datasetFields = store.datasets.get("warehouse")!.allowedFields;
    const contracts = [...store.contracts.values()].filter((contract) => contract.datasetId === "warehouse");
    expect(contracts.length).toBeGreaterThan(0);
    for (const contract of contracts) {
      expect(contract.allowFields?.length, contract.id).toBeGreaterThan(0);
      expect(contract.allowFields!.every((field) => datasetFields.includes(field)), contract.id).toBe(true);
      expect(contract.denyFields.every((field) => !contract.allowFields!.includes(field)), contract.id).toBe(true);
    }
    expect(store.contracts.get("wh.data-owner")!.allowFields).toEqual(datasetFields);
  });
});

describe("persona isolation on shared BW vendor analytics", () => {
  it("ACME consumer sees only ACME vendors", () => {
    const store = seedStore();
    const { decision, records } = filterDataset(store, "emma.acme", "bw_vendor", "vendor-performance");
    expect(decision.effect).toBe("allow");
    expect(vendorIds(records)).toEqual(["V1001", "V1002"]);
  });

  it("Globex consumer sees only Globex vendors and never ACME rows", () => {
    const store = seedStore();
    const { records } = filterDataset(store, "finn.globex", "bw_vendor", "vendor-performance");
    expect(vendorIds(records)).toEqual(["V2001", "V2002"]);
    expect(records.some((r) => String(r.attrs.vendor_name).includes("ACME"))).toBe(false);
  });

  it("L1 cannot see vendor analytics or S/4 master", () => {
    const store = seedStore();
    expect(filterDataset(store, "ana.l1", "bw_vendor", "vendor-performance").records).toHaveLength(0);
    expect(filterDataset(store, "ana.l1", "s4_vendor", "replication-repair").records).toHaveLength(0);
    expect(filterDataset(store, "ana.l1", "sla", "incident-triage").records).toHaveLength(1);
  });

  it("L1 process-chain status strips vendor_id", () => {
    const store = seedStore();
    const { records } = filterDataset(store, "ana.l1", "pc_status", "incident-triage");
    expect(records).toHaveLength(1);
    expect(records[0]?.attrs.vendor_id).toBeUndefined();
    expect(records[0]?.attrs.status).toBe("SUCCESS");
  });

  it("platform admin has no standing data-plane access", () => {
    const store = seedStore();
    expect(filterDataset(store, "hugo.admin", "bw_vendor", "vendor-performance").records).toHaveLength(0);
    expect(filterDataset(store, "hugo.admin", "s4_vendor", "replication").records).toHaveLength(0);
    expect(check(store, { principalId: "hugo.admin", action: "audit", datasetId: "audit", purpose: "governance" }).effect).toBe("allow");
    expect(check(store, { principalId: "hugo.admin", action: "view", datasetId: "bw_vendor" }).reason).toBe(
      "persona_lacks_verb",
    );
  });

  it("observability can read technical ES logs but payload fields are stripped", () => {
    const store = seedStore();
    const { records } = filterDataset(store, "dev.obs", "es_tech", "pipeline-reliability");
    expect(records.length).toBeGreaterThan(0);
    expect(records[0]?.attrs.payload).toBeUndefined();
    expect(filterDataset(store, "dev.obs", "es_payload", "pipeline-reliability").records).toHaveLength(0);
    expect(filterDataset(store, "dev.obs", "bw_vendor", "vendor-performance").records).toHaveLength(0);
  });

  it("L2 BOBJ cannot operate BW process-chain dumps", () => {
    const store = seedStore();
    expect(filterDataset(store, "cara.l2bobj", "pc_detail", "replication-repair").records).toHaveLength(0);
    expect(filterDataset(store, "cara.l2bobj", "bobj", "report-repair").records).toHaveLength(1);
  });

  it("L2 BW sees process-chain detail but not S/4 master without JIT", () => {
    const store = seedStore();
    expect(filterDataset(store, "ben.l2bw", "pc_detail", "replication-repair").records).toHaveLength(1);
    expect(filterDataset(store, "ben.l2bw", "s4_vendor", "replication-repair").records).toHaveLength(0);
  });

  it("purpose mismatch is denied even when the slice would match", () => {
    const store = seedStore();
    const decision = check(store, {
      principalId: "emma.acme",
      action: "view",
      datasetId: "bw_vendor",
      purpose: "marketing-export",
    });
    expect(decision.effect).toBe("deny");
    expect(decision.reason).toBe("purpose_mismatch");
  });
});

describe("JIT dual control", () => {
  it("rejects self-approval and non-admin approvers", () => {
    const store = seedStore();
    const grant = requestJit(store, {
      requesterId: "ben.l2bw",
      principalId: "ben.l2bw",
      datasetId: "bw_vendor",
      capsuleId: "support-l2-bw",
      purpose: "replication-repair",
      now: 1_000,
    });
    expect(() =>
      approveJit(store, { jitId: grant.id, approverId: "ben.l2bw", now: 1_100 }),
    ).toThrow(/dual_control/);
    expect(() =>
      approveJit(store, { jitId: grant.id, approverId: "emma.acme", now: 1_100 }),
    ).toThrow(/control-plane admin/);
  });

  it("admin approval grants a time-boxed, row- and field-scoped vendor diagnostic view", () => {
    const store = seedStore();
    const grant = requestJit(store, {
      requesterId: "ben.l2bw",
      principalId: "ben.l2bw",
      datasetId: "bw_vendor",
      capsuleId: "support-l2-bw",
      purpose: "replication-repair",
      now: 5_000,
    });
    approveJit(store, { jitId: grant.id, approverId: "hugo.admin", ttlMs: 60_000, now: 6_000 });
    const live = filterDataset(store, "ben.l2bw", "bw_vendor", "replication-repair", 10_000);
    expect(vendorIds(live.records)).toEqual(["V1001", "V1002"]);
    expect(live.records.every((record) => record.attrs.spend === undefined)).toBe(true);
    const dead = filterDataset(store, "ben.l2bw", "bw_vendor", "replication-repair", 70_000);
    expect(dead.records).toHaveLength(0);
  });
});

describe("capsule offboarding", () => {
  it("removing ACME revokes Emma without touching Globex", () => {
    const store = seedStore();
    const result = offboardCapsule(store, { capsuleId: "vendor-acme", actorId: "hugo.admin" });
    expect(result.removedMembers).toContain("emma.acme");
    expect(filterDataset(store, "emma.acme", "bw_vendor", "vendor-performance").records).toHaveLength(0);
    expect(vendorIds(filterDataset(store, "finn.globex", "bw_vendor", "vendor-performance").records)).toEqual([
      "V2001",
      "V2002",
    ]);
    expect(store.capsules.get("vendor-acme")?.active).toBe(false);
    expect(store.audit.at(-1)?.type).toBe("capsule.offboard");
    expect(store.audit.at(-1)?.prevHash).toBe(store.audit.at(-2)?.hash);
  });

  it("refuses to delete the control-plane capsule", () => {
    const store = seedStore();
    expect(() => offboardCapsule(store, { capsuleId: "control-plane", actorId: "hugo.admin" })).toThrow(
      /control-plane/,
    );
  });
});

describe("compiler", () => {
  it("emits ES DLS terms from capsule vendor_set", () => {
    const store = seedStore();
    const policy = compileCapsule(store, "vendor-acme");
    const query = policy.elasticsearch.find((r) => r.name.includes("vendor-acme"))?.indices[0]?.query;
    expect(query).toEqual({ terms: { vendor_id: ["V1001", "V1002", "ACME"] } });
    expect(policy.dashboards.spaces).toContain("vendor-acme");
    expect(policy.bw[0]?.name).toMatch(/ZCCA_VENDOR_ACME/);
  });
});

describe("predicate engine", () => {
  it("evaluates fromCapsuleAttr against vendor_set", () => {
    const store = seedStore();
    const capsule = store.capsules.get("vendor-acme")!;
    const contract = store.contracts.get("vendor.acme.slice")!;
    expect(evalPredicate(contract.predicate, { vendor_id: "V1001" }, capsule)).toBe(true);
    expect(evalPredicate(contract.predicate, { vendor_id: "V2001" }, capsule)).toBe(false);
  });
});

describe("explainAccess", () => {
  it("shows L1 only health surfaces", () => {
    const store = seedStore();
    const rows = explainAccess(store, "ana.l1");
    const allowed = rows.filter((r) => r.rowCount > 0).map((r) => r.datasetId);
    expect(allowed.sort()).toEqual(["pc_status", "sla"]);
  });

  it("limits explanations to an optional trusted purpose", () => {
    const store = seedStore();
    const incident = explainAccess(store, "ana.l1", undefined, "incident-triage");
    expect(incident.filter((surface) => surface.rowCount > 0).map((surface) => surface.datasetId).sort())
      .toEqual(["pc_status", "sla"]);
    const unrelated = explainAccess(store, "ana.l1", undefined, "vendor-performance");
    expect(unrelated.every((surface) => surface.rowCount === 0)).toBe(true);
  });
});
