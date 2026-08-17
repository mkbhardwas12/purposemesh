import type { RoleDraft, RoleToken } from "./api";

export function emptyDraft(): RoleDraft {
  return {
    name: "",
    verbs: [],
    purpose: "",
    ceiling: "internal",
    products: [],
    tenants: [],
    regions: [],
    departments: [],
    denyFields: [],
    sources: [],
  };
}

export function applyToken(draft: RoleDraft, token: RoleToken): RoleDraft {
  const next = { ...draft };
  switch (token.group) {
    case "verb":
      next.verbs = toggle(next.verbs, token.id);
      break;
    case "purpose":
      next.purpose = next.purpose === token.id ? "" : token.id;
      break;
    case "ceiling":
      next.ceiling = token.id as RoleDraft["ceiling"];
      break;
    case "product":
      next.products = toggle(next.products, token.id);
      break;
    case "tenant":
      next.tenants = toggle(next.tenants, token.id);
      break;
    case "region":
      next.regions = toggle(next.regions, token.id);
      break;
    case "department":
      next.departments = toggle(next.departments, token.id);
      break;
    case "mask":
      next.denyFields = toggle(next.denyFields, token.id);
      break;
    case "source":
      next.sources = toggle(next.sources, token.id);
      break;
    default:
      break;
  }
  return next;
}

export function removeToken(draft: RoleDraft, group: string, id: string): RoleDraft {
  return applyToken(draft, { id, label: id, group });
}

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function validateDraft(draft: RoleDraft): string[] {
  const errors: string[] = [];
  if (!draft.name.trim()) errors.push("Give the role a clear name.");
  if (draft.verbs.length === 0) errors.push("Select at least one permitted action.");
  if (!draft.purpose.trim()) errors.push("Select a business purpose.");
  if (draft.verbs.length > 0 && draft.products.length === 0) {
    errors.push("Select at least one data product for the requested actions.");
  }
  return errors;
}

export function draftReadyForPreview(draft: RoleDraft): boolean {
  return validateDraft({ ...draft, name: draft.name.trim() || "Preview role" }).length === 0;
}
