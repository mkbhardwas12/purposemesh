import { describe, expect, it } from "vitest";
import {
  MAX_JIT_TTL_MS,
  CcaStore,
  addMembership,
  applyRoleDraft,
  approveJit,
  denyJit,
  check,
  compileCapsule,
  compilePredicateToElasticsearch,
  filterDataset,
  hashPassword,
  isAdminPersona,
  isControlPlaneAdmin,
  projectAttrs,
  removeMembership,
  requestJit,
  revokeJit,
  seedStore,
  verifyPassword,
  warehouseScopesFor,
  type RoleDraft,
} from "../src/index.js";

function draft(name: string, tenant: string): RoleDraft {
  return {
    name,
    verbs: ["view"],
    purpose: "analytics",
    ceiling: "confidential",
    products: ["transactions"],
    tenants: [tenant],
    regions: [],
    departments: [],
    denyFields: ["account_number"],
    sources: ["generic"],
  };
}

describe("PDP fail-closed invariants", () => {
  it("requires purpose and validates record dataset identity", () => {
    const store = seedStore();
    const row = store.records.find((record) => record.id === "bw-1")!;
    expect(check(store, {
      principalId: "emma.acme",
      action: "view",
      datasetId: "bw_vendor",
      record: row,
    }).reason).toBe("purpose_required");
    expect(check(store, {
      principalId: "emma.acme",
      action: "view",
      datasetId: "sla",
      record: row,
      purpose: "incident-triage",
    }).reason).toBe("record_dataset_mismatch");
  });

  it("enforces actual record classification against contract and persona ceilings", () => {
    const store = seedStore();
    const restrictedSla = {
      id: "sla-restricted",
      datasetId: "sla",
      classification: "restricted" as const,
      attrs: { chain: "sensitive" },
    };
    expect(check(store, {
      principalId: "ana.l1",
      action: "view",
      datasetId: "sla",
      record: restrictedSla,
      purpose: "incident-triage",
    }).reason).toBe("contract_classification_limit");

    store.contracts.set("test.l2.s4", {
      id: "test.l2.s4",
      datasetId: "s4_vendor",
      purpose: "replication-repair",
      allowedPersonas: ["l2bw"],
      actions: ["view"],
      classificationMax: "restricted",
      predicate: { op: "true" },
      denyFields: [],
    });
    store.bindings.push({
      id: "test.l2.s4.binding",
      capsuleId: "support-l2-bw",
      contractId: "test.l2.s4",
    });
    const forgedDowngrade = {
      id: "s4-forged",
      datasetId: "s4_vendor",
      classification: "internal" as const,
      attrs: { vendor_id: "V1001" },
    };
    expect(check(store, {
      principalId: "ben.l2bw",
      action: "view",
      datasetId: "s4_vendor",
      record: forgedDowngrade,
      purpose: "replication-repair",
    }).reason).toBe("classification_ceiling");
  });

  it("evaluates every matching contract and combines field obligations deterministically", () => {
    const store = seedStore();
    const first = store.contracts.get("vendor.acme.slice")!;
    first.predicate = { op: "eq", field: "vendor_id", value: "never" };
    first.denyFields = ["vendor_name"];
    store.contracts.set("vendor.acme.second", {
      ...first,
      id: "vendor.acme.second",
      predicate: { op: "eq", field: "vendor_id", value: "V1001" },
      denyFields: ["spend"],
    });
    store.bindings.push({
      id: "vendor-acme-second",
      capsuleId: "vendor-acme",
      contractId: "vendor.acme.second",
    });
    const row = store.records.find((record) => record.id === "bw-1")!;
    const oneAllow = check(store, {
      principalId: "emma.acme",
      action: "view",
      datasetId: "bw_vendor",
      record: row,
      purpose: "vendor-performance",
    });
    expect(oneAllow.effect).toBe("allow");
    expect(oneAllow.contractId).toBe("vendor.acme.second");

    first.predicate = { op: "true" };
    const combined = check(store, {
      principalId: "emma.acme",
      action: "view",
      datasetId: "bw_vendor",
      record: row,
      purpose: "vendor-performance",
    });
    expect(combined.contractIds).toEqual(["vendor.acme.second", "vendor.acme.slice"]);
    expect(combined.allowedFields).toEqual(["region", "spend", "vendor_id", "vendor_name"]);
    expect(combined.denyFields).toEqual(["spend", "vendor_name"]);
  });

  it("does not release new or nested record fields until each leaf is allowlisted", () => {
    const store = seedStore();
    const dataset = store.datasets.get("bw_vendor")!;
    const row = store.records.find((record) => record.id === "bw-1")!;
    row.attrs.unreviewed_secret = "do-not-release";
    row.attrs.profile = { display: "approved", secret: "nested-secret" };

    let released = filterDataset(store, "emma.acme", "bw_vendor", "vendor-performance").records[0]!.attrs;
    expect(released.unreviewed_secret).toBeUndefined();
    expect(released.profile).toBeUndefined();

    dataset.allowedFields.push("unreviewed_secret", "profile.display");
    released = filterDataset(store, "emma.acme", "bw_vendor", "vendor-performance").records[0]!.attrs;
    expect(released.unreviewed_secret).toBe("do-not-release");
    expect(released.profile).toEqual({ display: "approved" });
    expect((released.profile as { secret?: string }).secret).toBeUndefined();
  });

  it("never treats an arbitrary governance-purpose capsule as the control plane", () => {
    const store = seedStore();
    store.personas.get("consumer")!.actions.push("audit");
    store.capsules.set("fake-governance", {
      id: "fake-governance",
      label: "Fake governance",
      purpose: "governance",
      active: true,
      attrs: {},
    });
    store.memberships.push({ principalId: "emma.acme", capsuleId: "fake-governance" });
    expect(check(store, {
      principalId: "emma.acme",
      action: "audit",
      datasetId: "audit",
      purpose: "governance",
    }).reason).toBe("control_plane_capsule_required");
  });

  it("requires the admin persona even with exact control-plane membership", () => {
    const store = seedStore();
    store.personas.get("steward")!.inherits = "admin";
    store.memberships.push({ principalId: "gita.steward", capsuleId: "control-plane" });
    expect(isControlPlaneAdmin(store, "gita.steward")).toBe(false);
    expect(isAdminPersona(store.personas.get("steward"))).toBe(false);
    expect(check(store, {
      principalId: "gita.steward",
      action: "administer",
      datasetId: "audit",
      purpose: "governance",
    })).toMatchObject({ effect: "deny", reason: "control_plane_admin_required" });

    const clean = seedStore();
    clean.personas.get("steward")!.inherits = "admin";
    expect(() => addMembership(clean, "hugo.admin", "gita.steward", "control-plane"))
      .toThrow(/admin persona/);
    expect(() => addMembership(clean, "hugo.admin", "finn.globex", "vendor-acme"))
      .toThrow(/role-request approval workflow/);
    removeMembership(clean, "hugo.admin", "iris.admin", "control-plane");
    expect(() => removeMembership(clean, "hugo.admin", "hugo.admin", "control-plane"))
      .toThrow(/last active/);
    addMembership(clean, "hugo.admin", "iris.admin", "control-plane");
    expect(isControlPlaneAdmin(clean, "iris.admin")).toBe(true);
  });
});

describe("role lifecycle isolation", () => {
  it("rejects self-authored roles and reserves assignment for active control-plane admins", () => {
    const store = seedStore();
    expect(() => applyRoleDraft(store, {
      actorId: "emma.acme",
      principalId: "emma.acme",
      draft: draft("Self governance", "ACME"),
    })).toThrow(/control-plane membership/);
  });

  it("reuses stable personas while keeping ACME and Globex scopes separate", () => {
    const store = seedStore();
    const emmaV1 = applyRoleDraft(store, {
      actorId: "hugo.admin",
      principalId: "emma.acme",
      draft: draft("Quarterly role", "ACME"),
    });
    const finn = applyRoleDraft(store, {
      actorId: "hugo.admin",
      principalId: "finn.globex",
      draft: draft("Quarterly role", "GLOBEX"),
    });
    const emmaV2 = applyRoleDraft(store, {
      actorId: "hugo.admin",
      principalId: "emma.acme",
      draft: draft("Quarterly role", "ACME"),
    });
    expect(new Set([emmaV1.personaId, finn.personaId, emmaV2.personaId]).size).toBe(1);
    expect(emmaV2).toEqual(emmaV1);
    expect(finn.capsuleId).not.toBe(emmaV1.capsuleId);
    expect(store.capsules.get(emmaV1.capsuleId)?.active).toBe(true);
    expect(isAdminPersona(store.personas.get(emmaV2.personaId))).toBe(false);
  });

  it("requires a trusted purpose when deriving warehouse scopes", () => {
    const store = seedStore();
    expect(warehouseScopesFor(store, "emma.acme")).toEqual([]);
    const scopes = warehouseScopesFor(store, "emma.acme", "analytics");
    expect(scopes).toHaveLength(1);
    expect(scopes[0]?.tenants).toEqual(["ACME"]);
    expect(scopes[0]?.products).toContain("transactions");
  });
});

describe("bounded JIT grants", () => {
  it("binds requester, capsule membership, purpose, and explicit actions", () => {
    const store = seedStore();
    expect(() => requestJit(store, {
      requesterId: "ana.l1",
      principalId: "ben.l2bw",
      datasetId: "s4_vendor",
      capsuleId: "support-l2-bw",
      purpose: "replication-repair",
    })).toThrow(/target principal/);
    expect(() => requestJit(store, {
      requesterId: "ben.l2bw",
      principalId: "ben.l2bw",
      datasetId: "s4_vendor",
      capsuleId: "support-l2-bw",
      purpose: "export",
    })).toThrow(/purpose/);

    expect(() => requestJit(store, {
      requesterId: "ben.l2bw",
      principalId: "ben.l2bw",
      datasetId: "s4_vendor",
      capsuleId: "support-l2-bw",
      purpose: "replication-repair",
      now: 1_000,
    })).toThrow(/no eligible approval-required contract/);

    store.contracts.set("test.restricted-jit", {
      id: "test.restricted-jit",
      datasetId: "s4_vendor",
      purpose: "replication-repair",
      allowedPersonas: ["l2bw"],
      actions: ["view"],
      classificationMax: "restricted",
      predicate: { op: "true" },
      allowFields: ["vendor_id"],
      denyFields: [],
      approvalRequired: true,
    });
    store.bindings.push({
      id: "test.restricted-jit-binding",
      capsuleId: "support-l2-bw",
      contractId: "test.restricted-jit",
    });
    expect(() => requestJit(store, {
      requesterId: "ben.l2bw",
      principalId: "ben.l2bw",
      datasetId: "s4_vendor",
      capsuleId: "support-l2-bw",
      purpose: "replication-repair",
      now: 1_000,
    })).toThrow(/classification exceeds/);

    const grant = requestJit(store, {
      requesterId: "ben.l2bw",
      principalId: "ben.l2bw",
      datasetId: "bw_vendor",
      capsuleId: "support-l2-bw",
      purpose: "replication-repair",
      now: 1_000,
    });
    expect(grant.allowedFields).toEqual(["region", "vendor_id", "vendor_name"]);
    expect(grant.classificationMax).toBe("confidential");
    expect(grant.contractId).toBe("jit.l2bw.vendor-diagnostics");
    expect(grant.policyVersion).toMatch(/^jit-[a-f0-9]{24}$/);
    expect(() => approveJit(store, {
      jitId: grant.id,
      approverId: "hugo.admin",
      ttlMs: Number.NaN,
      now: 2_000,
    })).toThrow(/ttl/);
    expect(() => approveJit(store, {
      jitId: grant.id,
      approverId: "hugo.admin",
      ttlMs: MAX_JIT_TTL_MS + 1,
      now: 2_000,
    })).toThrow(/ttl/);
    approveJit(store, { jitId: grant.id, approverId: "hugo.admin", ttlMs: 60_000, now: 2_000 });
    expect(check(store, {
      principalId: "ben.l2bw",
      action: "operate",
      datasetId: "bw_vendor",
      purpose: "replication-repair",
      now: 3_000,
    }).effect).toBe("deny");
    const record = store.records.find((item) => item.id === "bw-1")!;
    const decision = check(store, {
      principalId: "ben.l2bw",
      action: "view",
      datasetId: "bw_vendor",
      record,
      purpose: "replication-repair",
      now: 3_000,
    });
    expect(decision.reason).toBe("jit_allow");
    store.datasets.get("bw_vendor")!.allowedFields.push("future_sensitive_field");
    expect(check(store, {
      principalId: "ben.l2bw",
      action: "view",
      datasetId: "bw_vendor",
      record,
      purpose: "replication-repair",
      now: 3_000,
    }).allowedFields).not.toContain("future_sensitive_field");
  });

  it("freezes ACME row scope, blocks Globex, and supports immediate audited revocation", () => {
    const store = seedStore();
    const grant = requestJit(store, {
      requesterId: "ben.l2bw",
      principalId: "ben.l2bw",
      datasetId: "bw_vendor",
      capsuleId: "support-l2-bw",
      purpose: "replication-repair",
      justification: "Investigate ACME replication incident",
      requestedTtlMs: 60_000,
      ticket: "INC-1001",
      now: 1_000,
    });
    approveJit(store, { jitId: grant.id, approverId: "hugo.admin", ttlMs: 60_000, now: 2_000 });
    store.capsules.get("support-l2-bw")!.attrs.vendor_set = ["V2001"];
    const visible = filterDataset(store, "ben.l2bw", "bw_vendor", "replication-repair", 3_000);
    expect(visible.records.map((record) => record.attrs.vendor_id)).toEqual(["V1001", "V1002"]);
    expect(visible.records.every((record) => record.attrs.spend === undefined)).toBe(true);
    revokeJit(store, { jitId: grant.id, actorId: "ben.l2bw", reason: "incident resolved", now: 4_000 });
    expect(grant.status).toBe("revoked");
    expect(filterDataset(store, "ben.l2bw", "bw_vendor", "replication-repair", 5_000).records).toEqual([]);
    expect(store.audit.at(-1)).toMatchObject({ actorId: "ben.l2bw", type: "jit.revoke" });
  });

  it("records an explicit dual-controlled JIT denial without activating access", () => {
    const store = seedStore();
    const grant = requestJit(store, {
      requesterId: "ben.l2bw",
      principalId: "ben.l2bw",
      datasetId: "bw_vendor",
      capsuleId: "support-l2-bw",
      purpose: "replication-repair",
      justification: "Investigate replication without standing access",
      requestedTtlMs: 60_000,
      now: 1_000,
    });

    expect(() => denyJit(store, {
      jitId: grant.id,
      denierId: "ben.l2bw",
      reason: "self denial",
      now: 2_000,
    })).toThrow(/requester cannot deny/);

    denyJit(store, {
      jitId: grant.id,
      denierId: "hugo.admin",
      reason: "Insufficient incident evidence",
      now: 2_000,
    });

    expect(grant).toMatchObject({
      status: "denied",
      deniedAt: 2_000,
      deniedBy: "hugo.admin",
      denialReason: "Insufficient incident evidence",
    });
    expect(() => approveJit(store, {
      jitId: grant.id,
      approverId: "hugo.admin",
      now: 3_000,
    })).toThrow(/not pending/);
    expect(filterDataset(store, "ben.l2bw", "bw_vendor", "replication-repair", 3_000).records).toEqual([]);
    expect(store.audit.at(-1)).toMatchObject({ actorId: "hugo.admin", type: "jit.deny" });
  });

  it("revokes live JIT when its capsule membership is removed", () => {
    const store = seedStore();
    const grant = requestJit(store, {
      requesterId: "ben.l2bw",
      principalId: "ben.l2bw",
      datasetId: "bw_vendor",
      capsuleId: "support-l2-bw",
      purpose: "replication-repair",
      now: 1_000,
    });
    approveJit(store, { jitId: grant.id, approverId: "hugo.admin", now: 2_000 });
    removeMembership(store, "hugo.admin", "ben.l2bw", "support-l2-bw");
    expect(grant.status).toBe("expired");
  });
});

describe("native compiler equivalence", () => {
  it("emits only active persona-compatible assignments and blocks apply without purpose enforcement", () => {
    const store = seedStore();
    const compiled = compileCapsule(store, "vendor-acme");
    expect(compiled.policyVersion).toBe(`cca-${compiled.policyHash.slice(0, 24)}`);
    expect(compiled.assignments.map((assignment) => assignment.principalId).sort())
      .toEqual(["emma.acme", "gita.steward"]);
    expect(compiled.assignments.some((assignment) => assignment.principalId === "finn.globex")).toBe(false);
    expect(compiled).toMatchObject({ deploymentStatus: "blocked", previewOnly: true });
    expect(compiled.plan).toEqual({ apply: [], revoke: [], readback: [] });
    expect(compiled.capabilityGates).toContainEqual(expect.objectContaining({
      target: "elasticsearch",
      status: "blocked",
      missing: expect.arrayContaining(["purpose_binding"]),
    }));

    store.memberships.find((membership) =>
      membership.principalId === "emma.acme" && membership.capsuleId === "vendor-acme"
    )!.personaId = "l1";
    const narrowed = compileCapsule(store, "vendor-acme");
    expect(narrowed.assignments.some((assignment) => assignment.principalId === "emma.acme")).toBe(false);
    expect(narrowed.policyHash).not.toBe(compiled.policyHash);
  });

  it("models least-privilege identities for every S/4 to BW to ES stage", () => {
    const store = seedStore();
    expect(check(store, {
      principalId: "pc.vendor.replicate",
      action: "view",
      datasetId: "s4_vendor",
      purpose: "replication",
    }).effect).toBe("allow");
    expect(check(store, {
      principalId: "pc.vendor.replicate",
      action: "operate",
      datasetId: "bw_vendor_stage",
      purpose: "replication",
    }).effect).toBe("allow");
    expect(check(store, {
      principalId: "pc.vendor.replicate",
      action: "operate",
      datasetId: "bw_vendor",
      purpose: "replication",
    }).effect).toBe("deny");
    expect(check(store, {
      principalId: "pc.vendor.activate",
      action: "view",
      datasetId: "bw_vendor_stage",
      purpose: "replication",
    }).effect).toBe("allow");
    expect(check(store, {
      principalId: "pc.vendor.activate",
      action: "operate",
      datasetId: "bw_vendor",
      purpose: "replication",
    }).effect).toBe("allow");
    expect(check(store, {
      principalId: "pc.vendor.telemetry",
      action: "operate",
      datasetId: "es_tech",
      purpose: "replication",
    }).effect).toBe("allow");

    const source = compileCapsule(store, "pipeline-replicate");
    const activation = compileCapsule(store, "pipeline-bw-activate");
    const telemetry = compileCapsule(store, "pipeline-es-publish");
    expect(source.assignments.map((assignment) => assignment.principalId)).toEqual(["pc.vendor.replicate"]);
    expect(activation.assignments.map((assignment) => assignment.principalId)).toEqual(["pc.vendor.activate"]);
    expect(telemetry.assignments.map((assignment) => assignment.principalId)).toEqual(["pc.vendor.telemetry"]);
    expect(source.adf.identities[0]).toContain("pc-vendor-replicate");
    expect(activation.adf.identities[0]).toContain("pc-vendor-activate");
    expect(telemetry.adf.identities[0]).toContain("pc-vendor-telemetry");
  });

  it("recursively translates every predicate operator and fails closed on missing attributes", () => {
    const capsule = seedStore().capsules.get("vendor-acme")!;
    expect(compilePredicateToElasticsearch({
      op: "and",
      clauses: [
        { op: "in", field: "region", values: ["NA", "EU"] },
        {
          op: "or",
          clauses: [
            { op: "eq", field: "status", value: "ok" },
            { op: "fromCapsuleAttr", field: "vendor_id", attr: "vendor_set" },
          ],
        },
      ],
    }, capsule)).toEqual({
      bool: {
        filter: [
          { terms: { region: ["NA", "EU"] } },
          {
            bool: {
              should: [
                { term: { status: "ok" } },
                { terms: { vendor_id: ["V1001", "V1002", "ACME"] } },
              ],
              minimum_should_match: 1,
            },
          },
        ],
      },
    });
    expect(compilePredicateToElasticsearch({
      op: "fromCapsuleAttr",
      field: "vendor_id",
      attr: "missing",
    }, capsule)).toEqual({ match_none: {} });
    expect(compilePredicateToElasticsearch({ op: "or", clauses: [] }, capsule)).toEqual({ match_none: {} });
  });

  it("uses distinct ES dataset patterns and never widens a missing BW scope", () => {
    const store = seedStore();
    const contract = store.contracts.get("vendor.acme.slice")!;
    contract.predicate = { op: "fromCapsuleAttr", field: "vendor_id", attr: "missing" };
    const vendor = compileCapsule(store, "vendor-acme");
    expect(vendor.elasticsearch.find((role) => role.name.includes("vendor-acme-slice"))
      ?.indices[0]?.query).toEqual({ match_none: {} });
    expect(vendor.bw[0]?.characteristics[0]?.values).toEqual([]);
    expect(vendor.capabilityGates).toContainEqual(expect.objectContaining({
      target: "elasticsearch",
      contractId: "vendor.acme.slice",
      status: "blocked",
      missing: expect.arrayContaining(["row_filter", "purpose_binding"]),
    }));

    const obs = compileCapsule(store, "platform-obs");
    const esPattern = obs.elasticsearch.find((role) => role.name.includes("es-pipeline-tech"))
      ?.indices[0]?.names[0];
    expect(esPattern).toMatch(/^es_tech-[a-f0-9]{12}-\*$/);
    expect(() => {
      store.capsules.get("platform-obs")!.active = false;
      compileCapsule(store, "platform-obs");
    }).toThrow(/inactive capsule/);
  });

  it("marks safe native previews non-deployable when classification equivalence cannot be proven", () => {
    const store = seedStore();
    const contract = store.contracts.get("pc.ops-full")!;
    contract.classificationMax = "internal";

    const row = store.records.find((record) => record.datasetId === "pc_detail")!;
    expect(check(store, {
      principalId: "ben.l2bw",
      action: "view",
      datasetId: "pc_detail",
      record: row,
      purpose: "replication-repair",
    }).reason).toBe("contract_classification_limit");

    const compiled = compileCapsule(store, "support-l2-bw");
    const elasticsearch = compiled.elasticsearch.find((role) => role.name.includes("pc-ops-full"));
    expect(elasticsearch?.indices[0]?.query).toEqual({ match_none: {} });
    expect(compiled.bw.find((role) => role.infoProvider === "ZPC_MON")
      ?.characteristics[0]?.values).toEqual([]);
    expect(compiled.plan.apply).toEqual([]);
    expect(compiled.capabilityGates).toContainEqual(expect.objectContaining({
      target: "elasticsearch",
      contractId: "pc.ops-full",
      status: "blocked",
      missing: expect.arrayContaining(["classification_ceiling"]),
    }));

    store.capsules.set("blocked-runtime", {
      id: "blocked-runtime",
      label: "Blocked runtime",
      purpose: "replication",
      active: true,
      attrs: {},
    });
    store.memberships.push({
      principalId: "pc.vendor.replicate",
      capsuleId: "blocked-runtime",
    });
    store.contracts.set("blocked-runtime-contract", {
      id: "blocked-runtime-contract",
      datasetId: "s4_vendor",
      purpose: "replication",
      allowedPersonas: ["pipeline"],
      actions: ["operate"],
      classificationMax: "internal",
      predicate: { op: "true" },
      denyFields: [],
    });
    store.bindings.push({
      id: "blocked-runtime-binding",
      capsuleId: "blocked-runtime",
      contractId: "blocked-runtime-contract",
    });
    expect(compileCapsule(store, "blocked-runtime").adf).toEqual({ identities: [], vaultPaths: [] });
  });
});

describe("secure data handling and persistence", () => {
  it("deeply projects object and array fields without aliasing source data", () => {
    const source = {
      nested: { pii: { secret: "hide", keep: "ok" } },
      items: [{ secret: "one", keep: 1 }, { secret: "two", keep: 2 }],
    };
    const projected = projectAttrs(source, {
      allowedFields: ["nested.pii.keep", "nested.pii.secret", "items.keep", "items.secret"],
      denyFields: ["nested.pii.secret", "items.secret"],
    });
    expect(projected).toEqual({
      nested: { pii: { keep: "ok" } },
      items: [{ keep: 1 }, { keep: 2 }],
    });
    (projected.nested as { pii: { keep: string } }).pii.keep = "changed";
    expect(source.nested.pii.keep).toBe("ok");
  });

  it("round-trips a JSON snapshot with audit sequence and deep isolation", () => {
    const store = seedStore();
    store.appendAudit("hugo.admin", "test.event", { nested: { tenant: "ACME" } }, 10);
    const snapshot = store.snapshot();
    const restored = CcaStore.fromSnapshot(JSON.parse(JSON.stringify(snapshot)));
    expect(restored.verifyAuditChain()).toBe(true);
    const event = restored.appendAudit("hugo.admin", "test.next", {}, 11);
    expect(event.seq).toBe(snapshot.seq + 1);

    const restoredTenants = restored.capsules.get("vendor-acme")!.attrs.tenants as string[];
    restoredTenants.push("GLOBEX");
    expect(store.capsules.get("vendor-acme")!.attrs.tenants).toEqual(["ACME"]);

    const tampered = store.snapshot();
    tampered.audit[0]!.detail = { principals: 999 };
    expect(() => CcaStore.fromSnapshot(tampered)).toThrow(/audit chain/);
  });

  it("rejects persisted privilege and classification invariant violations", () => {
    const invalidMembership = seedStore().snapshot();
    invalidMembership.personas.find((persona) => persona.id === "steward")!.inherits = "admin";
    invalidMembership.memberships.push({
      principalId: "gita.steward",
      capsuleId: "control-plane",
    });
    expect(() => CcaStore.fromSnapshot(invalidMembership)).toThrow(/control-plane membership/);

    const invalidClassification = seedStore().snapshot();
    invalidClassification.records.find((record) => record.datasetId === "sla")!.classification = "restricted";
    expect(() => CcaStore.fromSnapshot(invalidClassification)).toThrow(/exceeds its dataset classification/);

    const emptyContractPersonas = seedStore().snapshot();
    emptyContractPersonas.contracts.find((contract) => contract.id === "vendor.acme.slice")!.allowedPersonas = [];
    expect(() => CcaStore.fromSnapshot(emptyContractPersonas)).toThrow(/contract personas must not be empty/);

    const runtimeEmptyContract = seedStore();
    runtimeEmptyContract.contracts.get("vendor.acme.slice")!.allowedPersonas = [];
    const acmeRecord = runtimeEmptyContract.records.find((record) => record.id === "bw-1")!;
    expect(check(runtimeEmptyContract, {
      principalId: "emma.acme",
      action: "view",
      datasetId: "bw_vendor",
      record: acmeRecord,
      purpose: "vendor-performance",
    })).toMatchObject({ effect: "deny", reason: "no_contract_binding" });

    const missingAllowlist = seedStore();
    delete (missingAllowlist.datasets.get("bw_vendor") as Partial<{ allowedFields: string[] }>).allowedFields;
    expect(check(missingAllowlist, {
      principalId: "emma.acme",
      action: "view",
      datasetId: "bw_vendor",
      purpose: "vendor-performance",
    }).reason).toBe("dataset_field_allowlist_missing");

    const nonLeafAllowlist = seedStore().snapshot();
    nonLeafAllowlist.datasets.find((dataset) => dataset.id === "es_tech")!.allowedFields = ["payload"];
    expect(() => CcaStore.fromSnapshot(nonLeafAllowlist)).toThrow(/is not a leaf/);
  });

  it("isolates seeded stores and uses salted memory-hard password hashes", () => {
    const first = seedStore();
    const second = seedStore();
    first.personas.get("consumer")!.actions.push("administer");
    expect(second.personas.get("consumer")!.actions).toEqual(["view"]);

    const left = hashPassword("same password");
    const right = hashPassword("same password");
    expect(left).not.toBe(right);
    expect(left).toMatch(/^scrypt\$v1\$/);
    expect(verifyPassword("same password", left)).toBe(true);
    expect(verifyPassword("wrong", left)).toBe(false);
    expect(verifyPassword("same password", "not-a-hash")).toBe(false);
  });
});
