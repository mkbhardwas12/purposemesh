export function decisionLabel(effect: string, reason: string): string {
  if (effect === "allow") return reason === "jit_allow" ? "JIT allow" : "Allow";
  return `Deny · ${reason.replaceAll("_", " ")}`;
}

export function visibleVendorIds(records: { attrs: Record<string, unknown> }[]): string[] {
  return records
    .map((row) => row.attrs.vendor_id)
    .filter((id): id is string => typeof id === "string")
    .sort();
}
