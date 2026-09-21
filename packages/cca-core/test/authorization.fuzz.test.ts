import { DatabaseSync } from "node:sqlite";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
  CLASS_RANK,
  compileScopeToSql,
  draftToPredicate,
  emptyRoleDraft,
  evalPredicate,
  intersectFieldPaths,
  projectAttrs,
  slugifyRoleName,
} from "../src/index.js";
import type { Capsule, DataScope, Predicate } from "../src/index.js";

function boundedInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!raw.trim() || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

// Always reproducible, including CI. fast-check reports the shrinking path and
// seed on failure; retain them with the failing input as a regression test.
const fuzz = {
  seed: boundedInteger("PURPOSEMESH_FUZZ_SEED", 20260920, -2147483648, 2147483647),
  numRuns: boundedInteger("PURPOSEMESH_FUZZ_RUNS", 500, 1, 20_000),
};
const codeUnit = fc.integer({ min: 0, max: 0xffff }).map((value) => String.fromCharCode(value));
const ascii = fc.integer({ min: 32, max: 126 }).map((value) => String.fromCharCode(value));
const text = fc.array(fc.oneof(ascii, codeUnit), { maxLength: 64 }).map((units) => units.join(""));
const scalar = fc.oneof(text, fc.integer(), fc.boolean(), fc.constant(null));
const capsule = (attrs: Record<string, unknown>): Capsule => ({
  id: "fuzz-capsule", label: "Synthetic policy", purpose: "test", active: true, attrs,
});

describe("authorization security properties", () => {
  it("preserves slug semantics over arbitrary UTF-16 and ASCII boundaries", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1720000000000);
    try {
      fc.assert(fc.property(
        fc.array(fc.oneof(ascii, codeUnit), { maxLength: 1024 }).map((units) => units.join("")),
        (name) => {
          // Independent tokenization oracle: no ambiguous edge-trimming regexp.
          const words = name.toLowerCase().match(/[a-z0-9]+/g) ?? [];
          const expected = words.join("-").slice(0, 40) || "draft-1720000000000";
          expect(slugifyRoleName(name)).toBe(expected);
        },
      ), fuzz);
    } finally {
      now.mockRestore();
    }
  });

  it("keeps SQL scope and capsule predicates equivalent to an independent row oracle", () => {
    const dimension = fc.oneof(text, fc.constantFrom("ACME", "GLOBEX", "NA", "EU", "sap", "' OR 1=1 --", "x'); DROP TABLE facts; --"));
    const dimensionSet = fc.uniqueArray(dimension, { maxLength: 5 });
    const rowArb = fc.record({
      product: dimension, tenant: dimension, region: dimension, department: dimension, source: dimension,
      class_rank: fc.integer({ min: 1, max: 3 }),
    });
    const scopeArb = fc.record({
      products: dimensionSet, tenants: dimensionSet, regions: dimensionSet,
      departments: dimensionSet, sources: dimensionSet,
      ceiling: fc.constantFrom("internal", "confidential", "restricted", "unknown"),
    });
    const db = new DatabaseSync(":memory:");
    try {
      fc.assert(fc.property(scopeArb, rowArb, fc.boolean(), (generated, candidate, inside) => {
        const scope = {
          ...generated,
          products: inside && generated.products.length === 0 ? [candidate.product] : generated.products,
        } as DataScope;
        const rank = Object.hasOwn(CLASS_RANK, scope.ceiling) ? CLASS_RANK[scope.ceiling] : 0;
        // Generate successful decisions as well as adversarial mismatches; a
        // compiler that simply denies every row must fail this property.
        const row = inside ? {
          product: scope.products[0] ?? candidate.product,
          tenant: scope.tenants[0] ?? candidate.tenant,
          region: scope.regions[0] ?? candidate.region,
          department: scope.departments[0] ?? candidate.department,
          source: scope.sources[0] ?? candidate.source,
          class_rank: rank > 0 ? Math.min(candidate.class_rank, rank) : candidate.class_rank,
        } : candidate;
        const expected = scope.products.includes(row.product)
          && (scope.tenants.length === 0 || scope.tenants.includes(row.tenant))
          && (scope.regions.length === 0 || scope.regions.includes(row.region))
          && (scope.departments.length === 0 || scope.departments.includes(row.department))
          && (scope.sources.length === 0 || scope.sources.includes(row.source))
          && row.class_rank <= rank;
        const filter = compileScopeToSql(scope);
        const selected = db.prepare(`SELECT 1 AS visible FROM
          (SELECT ? AS product, ? AS tenant, ? AS region, ? AS department, ? AS source, ? AS class_rank)
          WHERE ${filter.sql}`).get(
          row.product, row.tenant, row.region, row.department, row.source, row.class_rank,
          ...(filter.params as Array<string | number>),
        );
        expect(Boolean(selected)).toBe(expected);
        const predicate = draftToPredicate({ ...emptyRoleDraft(), ...scope, ceiling: scope.ceiling });
        const predicateAllowed = scope.products.length > 0 && row.class_rank <= rank
          && evalPredicate(predicate, row, capsule(scope));
        expect(predicateAllowed).toBe(expected);
      }), fuzz);
    } finally {
      db.close();
    }
  });

  it("retains exact equality, own-property lookup, and AND/OR truth tables", () => {
    fc.assert(fc.property(scalar, scalar, scalar, fc.boolean(), (value, allowed, other, own) => {
      const record = own ? { tenant: value } : Object.create({ tenant: value }) as Record<string, unknown>;
      const equality: Predicate = { op: "eq", field: "tenant", value: allowed };
      const membership: Predicate = { op: "in", field: "tenant", values: [allowed, other] };
      const relationship: Predicate = { op: "fromCapsuleAttr", field: "tenant", attr: "tenants" };
      const context = capsule({ tenants: [other] });
      const equal = own && value === allowed;
      const member = own && (value === allowed || value === other);
      const related = own && value === other;
      expect(evalPredicate(equality, record, context)).toBe(equal);
      expect(evalPredicate(membership, record, context)).toBe(member);
      expect(evalPredicate(relationship, record, context)).toBe(related);
      expect(evalPredicate({ op: "and", clauses: [equality, membership, relationship] }, record, context)).toBe(equal && member && related);
      expect(evalPredicate({ op: "or", clauses: [equality, membership, relationship] }, record, context)).toBe(equal || member || related);
      expect(evalPredicate(relationship, record, capsule({}))).toBe(false);
    }), fuzz);
  });

  it("never releases an unlisted or denied leaf and ignores schema growth", () => {
    const fields = ["id", "tenant", "account.email", "account.bank", "items.id", "items.secret"] as const;
    const deniedPaths = [...fields, "account", "items"] as const;
    fc.assert(fc.property(
      fc.record({ id: scalar, tenant: scalar, email: scalar, bank: scalar, secret: scalar }),
      fc.array(fc.record({ id: scalar, secret: scalar }), { maxLength: 5 }),
      fc.subarray([...fields]), fc.subarray([...deniedPaths]), scalar,
      (values, items, allowedFields, denyFields, future) => {
        const attrs = { id: values.id, tenant: values.tenant, account: { email: values.email, bank: values.bank }, items };
        const before = structuredClone(attrs);
        const actual = projectAttrs(attrs, { allowedFields, denyFields });
        // A shape-specific oracle preserves every array index and its values.
        // Comparing an unordered bag of leaves alone would miss row swaps,
        // duplication, or copying a permitted value from a different item.
        const expected: Record<string, unknown> = {};
        for (const field of ["id", "tenant"] as const) {
          if (allowedFields.includes(field) && !denyFields.includes(field)) expected[field] = attrs[field];
        }
        if (!denyFields.includes("account")
          && (allowedFields.includes("account.email") || allowedFields.includes("account.bank"))) {
          const account: Record<string, unknown> = {};
          if (allowedFields.includes("account.email") && !denyFields.includes("account.email")) account.email = values.email;
          if (allowedFields.includes("account.bank") && !denyFields.includes("account.bank")) account.bank = values.bank;
          expected.account = account;
        }
        if (!denyFields.includes("items")
          && (allowedFields.includes("items.id") || allowedFields.includes("items.secret"))) {
          expected.items = items.map((item) => {
            const projected: Record<string, unknown> = {};
            if (allowedFields.includes("items.id") && !denyFields.includes("items.id")) projected.id = item.id;
            if (allowedFields.includes("items.secret") && !denyFields.includes("items.secret")) projected.secret = item.secret;
            return projected;
          });
        }
        expect(actual).toEqual(expected);
        for (const [path] of leaves(actual)) {
          expect(allowedFields.includes(path as typeof fields[number])).toBe(true);
          expect(denyFields.some((denied) => path === denied || path.startsWith(`${denied}.`))).toBe(false);
        }
        const grown = { ...attrs, futureSecret: future, account: { ...attrs.account, futureSecret: future }, items: items.map((item) => ({ ...item, futureSecret: future })) };
        expect(projectAttrs(grown, { allowedFields, denyFields })).toEqual(actual);
        expect(attrs).toEqual(before);
      },
    ), fuzz);
  });

  it("adding deny paths cannot add data and repeated projection is idempotent", () => {
    const fields = ["id", "account.email", "account.bank", "items.id", "items.secret"];
    fc.assert(fc.property(text, text, fc.subarray(fields), fc.subarray(fields), fc.subarray(fields), (visible, secret, allowedFields, firstDenies, moreDenies) => {
      const attrs = { id: visible, account: { email: visible, bank: secret }, items: [{ id: visible, secret }] };
      const before = projectAttrs(attrs, { allowedFields, denyFields: firstDenies });
      const stronger = projectAttrs(attrs, { allowedFields, denyFields: [...firstDenies, ...moreDenies] });
      for (const [path, value] of leaves(stronger)) {
        expect(leaves(before).some(([oldPath, oldValue]) => path === oldPath && Object.is(value, oldValue))).toBe(true);
      }
      expect(projectAttrs(stronger, { allowedFields, denyFields: [...firstDenies, ...moreDenies] })).toEqual(stronger);
    }), fuzz);
  });

  it("field intersection matches an independent permission-set oracle without broadening or losing valid grants", () => {
    const fields = ["id", "account", "account.email", "account.bank", "items", "items.id", "items.secret"];
    // Explicit finite policy model, independent of the implementation's pairwise
    // path-intersection algorithm. Parents cover their named descendants.
    const coverage: Record<string, readonly string[]> = {
      id: ["id"], account: ["account", "account.email", "account.bank"],
      "account.email": ["account.email"], "account.bank": ["account.bank"],
      items: ["items", "items.id", "items.secret"],
      "items.id": ["items.id"], "items.secret": ["items.secret"],
    };
    const canonical = (paths: string[]) =>
      !(paths.includes("account") && (paths.includes("account.email") || paths.includes("account.bank")))
      && !(paths.includes("items") && (paths.includes("items.id") || paths.includes("items.secret")));
    fc.assert(fc.property(fc.subarray(fields), fc.subarray(fields), (current, frozen) => {
      const intersection = intersectFieldPaths(current, frozen);
      const currentPermissions = new Set(current.flatMap((field) => coverage[field]!));
      const frozenPermissions = new Set(frozen.flatMap((field) => coverage[field]!));
      const common = fields.filter((field) => currentPermissions.has(field) && frozenPermissions.has(field));
      const expected = canonical(current) && canonical(frozen)
        ? common.filter((field) =>
          !(common.includes("account") && ["account.email", "account.bank"].includes(field))
          && !(common.includes("items") && ["items.id", "items.secret"].includes(field))
        ).sort()
        : [];
      expect(intersection).toEqual(expected);
      for (const field of intersection) {
        expect(current.some((grant) => field === grant || field.startsWith(`${grant}.`))).toBe(true);
        expect(frozen.some((grant) => field === grant || field.startsWith(`${grant}.`))).toBe(true);
      }
      expect(intersectFieldPaths(frozen, current)).toEqual(intersection);
      expect(new Set(intersection).size).toBe(intersection.length);
      expect(intersectFieldPaths(current, [])).toEqual([]);
      // Every generated leaf subset is valid; an implementation returning []
      // for all inputs must fail whenever at least one leaf is granted.
      const leavesOnly = current.filter((field) => field !== "account" && field !== "items");
      expect(intersectFieldPaths(leavesOnly, leavesOnly)).toEqual([...leavesOnly].sort());
    }), fuzz);
  });

  it("does not expose inherited, prototype, or bulk nested-object fields", () => {
    const badPaths = ["__proto__", "constructor", "prototype", "account.__proto__", "account.constructor", " account.email", "account..email", "account."];
    fc.assert(fc.property(scalar, fc.subarray(badPaths), (secret, paths) => {
      const attrs = JSON.parse(JSON.stringify({ account: { email: secret }, inherited: secret })) as Record<string, unknown>;
      Object.defineProperty(attrs, "__proto__", { enumerable: true, value: { leaked: secret } });
      Object.defineProperty(attrs, "constructor", { enumerable: true, value: { leaked: secret } });
      const output = projectAttrs(attrs, { allowedFields: [...paths, "account"], denyFields: [] });
      expect(output).toEqual({});
      expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
      const inherited = Object.create({ hidden: secret }) as Record<string, unknown>;
      expect(projectAttrs(inherited, { allowedFields: ["hidden"], denyFields: [] })).toEqual({});
      expect(intersectFieldPaths(["account.email"], paths)).toEqual([]);
    }), fuzz);
  });
});

// Semantic path checks apply to each item; the projection oracle above separately
// verifies exact array order, cardinality, and per-item value association.
function leaves(value: unknown, prefix = ""): Array<[string, unknown]> {
  if (Array.isArray(value)) return value.flatMap((item) => leaves(item, prefix));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => leaves(child, prefix ? `${prefix}.${key}` : key));
  }
  return [[prefix, value]];
}
