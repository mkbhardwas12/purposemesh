import type { Capsule, Predicate } from "./types.js";

export function canonicalFieldPaths(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const fields: string[] = [];
  for (const item of value) {
    const path = safeFieldPath(item);
    if (path.length === 0) return undefined;
    fields.push(item as string);
  }
  if (new Set(fields).size !== fields.length) return undefined;
  const ordered = [...fields].sort();
  for (let index = 0; index < ordered.length - 1; index += 1) {
    if (ordered[index + 1]!.startsWith(`${ordered[index]}.`)) return undefined;
  }
  return ordered;
}

export function intersectFieldPaths(current: unknown, granted: unknown): string[] {
  const currentFields = canonicalFieldPaths(current);
  const priorFields = canonicalFieldPaths(granted);
  if (!currentFields || !priorFields) return [];
  const intersection = new Set<string>();
  for (const left of currentFields) {
    for (const right of priorFields) {
      if (left === right) intersection.add(left);
      else if (left.startsWith(`${right}.`)) intersection.add(left);
      else if (right.startsWith(`${left}.`)) intersection.add(right);
    }
  }
  return [...intersection].sort();
}

function readField(
  attrs: Record<string, unknown>,
  field: string,
): unknown {
  return field.split(".").reduce<unknown>((acc, part) => {
    if (acc === null || acc === undefined || typeof acc !== "object") {
      return undefined;
    }
    if (!Object.hasOwn(acc, part)) return undefined;
    return (acc as Record<string, unknown>)[part];
  }, attrs);
}

export function evalPredicate(
  predicate: Predicate,
  recordAttrs: Record<string, unknown>,
  capsule: Capsule,
): boolean {
  switch (predicate.op) {
    case "true":
      return true;
    case "eq":
      return readField(recordAttrs, predicate.field) === predicate.value;
    case "in": {
      const value = readField(recordAttrs, predicate.field);
      return predicate.values.some((item) => item === value);
    }
    case "fromCapsuleAttr": {
      const value = readField(recordAttrs, predicate.field);
      const allowed = capsule.attrs[predicate.attr];
      return Array.isArray(allowed) && allowed.some((item) => item === value);
    }
    case "and":
      return predicate.clauses.every((clause) =>
        evalPredicate(clause, recordAttrs, capsule),
      );
    case "or":
      return predicate.clauses.some((clause) =>
        evalPredicate(clause, recordAttrs, capsule),
      );
    default: {
      const _never: never = predicate;
      return _never;
    }
  }
}

export function projectAttrs(
  attrs: Record<string, unknown>,
  projection: { allowedFields: readonly string[]; denyFields: readonly string[] },
): Record<string, unknown> {
  if (
    !projection
    || !Array.isArray(projection.allowedFields)
    || !Array.isArray(projection.denyFields)
  ) return {};

  const allowTree = createAllowTree(projection.allowedFields);
  const projected = projectAllowed(attrs, allowTree);
  const next = projected && !Array.isArray(projected) && typeof projected === "object"
    ? projected as Record<string, unknown>
    : {};
  for (const field of projection.denyFields) {
    const path = safeFieldPath(field);
    if (path.length > 0) deletePath(next, path);
  }
  return next;
}

type AllowNode = {
  terminal: boolean;
  children: Map<string, AllowNode>;
};

function createAllowTree(fields: readonly string[]): AllowNode {
  const root: AllowNode = { terminal: false, children: new Map() };
  for (const field of fields) {
    const path = safeFieldPath(field);
    if (path.length === 0) continue;
    let node = root;
    for (const part of path) {
      let child = node.children.get(part);
      if (!child) {
        child = { terminal: false, children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    }
    node.terminal = true;
    node.children.clear();
  }
  return root;
}

function projectAllowed(value: unknown, node: AllowNode): unknown {
  if (node.terminal) {
    if (value !== null && typeof value === "object") {
      if (Array.isArray(value) && value.every((item) => item === null || typeof item !== "object")) {
        return structuredClone(value);
      }
      return undefined;
    }
    return structuredClone(value);
  }
  if (value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const projected = projectAllowed(item, node);
      return projected === undefined ? [] : [projected];
    });
  }
  const source = value as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const [field, child] of node.children) {
    if (!Object.hasOwn(source, field)) continue;
    const selected = projectAllowed(source[field], child);
    if (selected !== undefined) projected[field] = selected;
  }
  return projected;
}

function safeFieldPath(field: unknown): string[] {
  if (typeof field !== "string" || field.trim() !== field || !field) return [];
  const path = field.split(".");
  if (path.some((part) =>
    !part
    || part === "__proto__"
    || part === "prototype"
    || part === "constructor"
  )) return [];
  return path;
}

function deletePath(current: unknown, path: string[]): void {
  if (current === null || typeof current !== "object" || path.length === 0) return;

  if (Array.isArray(current)) {
    const [head, ...rest] = path;
    if (/^(0|[1-9]\d*)$/.test(head!)) {
      const index = Number(head);
      if (rest.length === 0) {
        if (index < current.length) current.splice(index, 1);
      } else {
        deletePath(current[index], rest);
      }
      return;
    }
    // A semantic path such as `items.secret` applies to every array element.
    for (const item of current) deletePath(item, path);
    return;
  }

  const [head, ...rest] = path;
  if (!head || !Object.hasOwn(current, head)) return;
  const object = current as Record<string, unknown>;
  if (rest.length === 0) {
    delete object[head];
    return;
  }
  deletePath(object[head], rest);
}
