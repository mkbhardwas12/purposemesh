import { describe, expect, it } from "vitest";
import {
  applyRoleDraft,
  compileScopeToSql,
  emptyRoleDraft,
  filterDataset,
  ROLE_PALETTE,
  seedStore,
  slugifyRoleName,
  validateRoleDraft,
} from "../src/index.js";

describe("role draft compiler", () => {
  it("requires name, verb, purpose, and a product for every warehouse action", () => {
    expect(validateRoleDraft(emptyRoleDraft()).length).toBeGreaterThan(0);
    expect(
      validateRoleDraft({
        ...emptyRoleDraft(),
        name: "NA finance",
        verbs: ["view"],
        purpose: "finance",
        products: ["transactions"],
      }),
    ).toEqual([]);
    expect(
      validateRoleDraft({
        ...emptyRoleDraft(),
        name: "Unscoped operator",
        verbs: ["operate"],
        purpose: "operations",
      }),
    ).toContain("drop at least one data product");
  });

  it("keeps governance verbs out of warehouse role authoring", () => {
    expect(ROLE_PALETTE.verbs.map((verb) => verb.id)).toEqual(["view", "operate"]);
    for (const verb of ["rotate", "administer", "audit"] as const) {
      expect(validateRoleDraft({
        ...emptyRoleDraft(),
        name: "Unsafe governance role",
        verbs: [verb],
        purpose: "operations",
      })).toContain("unknown verb");
    }
  });

  it("compiles dimension filters to parameterized SQL", () => {
    const filter = compileScopeToSql({
      products: ["transactions", "customers"],
      tenants: ["ACME"],
      regions: ["NA"],
      departments: [],
      sources: [],
      ceiling: "confidential",
    });
    expect(filter.sql).toContain("product IN (?,?)");
    expect(filter.sql).toContain("tenant IN (?)");
    expect(filter.sql).toContain("region IN (?)");
    expect(filter.sql).toContain("class_rank <= ?");
    expect(filter.params).toEqual(["transactions", "customers", "ACME", "NA", 2]);
  });

  it("denies an empty product list in SQL", () => {
    expect(compileScopeToSql({
      products: [],
      tenants: [],
      regions: [],
      departments: [],
      sources: [],
      ceiling: "internal",
    }).sql).toBe("1=0");
  });
});

describe("applyRoleDraft", () => {
  it("reuses a stable capability persona and keeps scope on the membership", () => {
    const store = seedStore();
    const applied = applyRoleDraft(store, {
      actorId: "hugo.admin",
      principalId: "emma.acme",
      draft: {
        name: "ACME NA finance",
        verbs: ["view"],
        purpose: "finance",
        ceiling: "confidential",
        products: ["transactions"],
        tenants: ["ACME"],
        regions: ["NA"],
        departments: ["finance"],
        denyFields: ["account_number"],
        sources: ["generic"],
      },
    });
    expect(applied.personaId).toMatch(/^capability\.[a-f0-9]{16}$/);
    expect(applied.inherits).toBeUndefined();
    expect(store.principals.get("emma.acme")?.personaId).toBe("consumer");
    expect(store.memberships).toContainEqual(expect.objectContaining({
      principalId: "emma.acme",
      capsuleId: applied.capsuleId,
      personaId: applied.personaId,
      assignmentId: expect.stringMatching(/^assignment\./),
    }));
    expect(store.contracts.get(applied.contractId)?.allowedPersonas).toEqual([applied.personaId]);
    const { records } = filterDataset(store, "emma.acme", "bw_vendor", "vendor-performance");
    expect(records).toHaveLength(2);
  });

  it("slugifies role names for stable ids", () => {
    expect(slugifyRoleName("EU Ops / Night")).toBe("eu-ops-night");
  });
});
