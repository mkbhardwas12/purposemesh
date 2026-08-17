import { useEffect, useId, useMemo, useState } from "react";
import type { Catalog, Principal, RoleDraft, RolePalette, RoleToken } from "./api";
import { Icon } from "./Icons";
import { applyToken, removeToken } from "./roleDraft";

type WellKey =
  | "verbs"
  | "purpose"
  | "ceiling"
  | "products"
  | "tenants"
  | "regions"
  | "departments"
  | "masks"
  | "sources";

const WELLS: { key: WellKey; title: string; hint: string; group: string }[] = [
  { key: "verbs", title: "Permitted actions", hint: "What the role may do", group: "verb" },
  { key: "purpose", title: "Business purpose", hint: "Why access is needed", group: "purpose" },
  { key: "ceiling", title: "Classification ceiling", hint: "Highest sensitivity", group: "ceiling" },
  { key: "products", title: "Data products", hint: "Authorized resources", group: "product" },
  { key: "tenants", title: "Tenants", hint: "No selection means every tenant", group: "tenant" },
  { key: "regions", title: "Regions", hint: "No selection means every region", group: "region" },
  { key: "departments", title: "Departments", hint: "No selection means every department", group: "department" },
  { key: "masks", title: "Field protection", hint: "Fields removed at query time", group: "mask" },
  { key: "sources", title: "Sources", hint: "SAP, generic, or both", group: "source" },
];

export function RoleStudio({
  draft,
  palette,
  catalog,
  principal,
  requestMode,
  targetId,
  managedCapsuleId,
  generating,
  previewing,
  previewReady,
  rationale,
  validationErrors,
  onChange,
  onTargetChange,
  onReview,
  onGenerate,
}: {
  draft: RoleDraft;
  palette: RolePalette | null;
  catalog: Catalog | null;
  principal: Principal;
  requestMode: "governed" | "self";
  targetId: string;
  managedCapsuleId: string;
  generating: boolean;
  previewing: boolean;
  previewReady: boolean;
  rationale: string[];
  validationErrors: string[];
  onChange: (draft: RoleDraft) => void;
  onTargetChange: (principalId: string) => void;
  onReview: (principalId: string) => void;
  onGenerate: (ask: string) => void;
}) {
  const [ask, setAsk] = useState("");
  const askId = useId();
  const nameId = useId();
  const targetIdLabel = useId();
  const groups = useMemo(() => {
    if (!palette) return [];
    return [
      { title: "Actions", tokens: palette.verbs },
      { title: "Purpose", tokens: palette.purposes },
      { title: "Ceiling", tokens: palette.ceilings },
      { title: "Products", tokens: palette.products },
      { title: "Sources", tokens: palette.sources ?? [] },
      { title: "Tenants", tokens: palette.tenants },
      { title: "Regions", tokens: palette.regions },
      { title: "Departments", tokens: palette.departments },
      { title: "Protected fields", tokens: palette.masks },
    ];
  }, [palette]);
  const targets = useMemo(
    () => catalog?.principals.filter((candidate) =>
      candidate.kind === "human"
        && !candidate.disabled
        && candidate.personaId !== "admin"
        && candidate.id !== principal.id
        && !catalog.memberships.some((membership) => membership.principalId === candidate.id && membership.capsuleId === "control-plane")
    ) ?? [],
    [catalog, principal.id],
  );

  useEffect(() => {
    if (requestMode === "self") {
      if (targetId !== principal.id) onTargetChange(principal.id);
      return;
    }
    if (targets.length > 0 && !targets.some((candidate) => candidate.id === targetId)) {
      onTargetChange(targets[0]!.id);
    }
  }, [onTargetChange, principal.id, requestMode, targetId, targets]);

  const validTarget = requestMode === "self"
    ? targetId === principal.id
    : targets.some((candidate) => candidate.id === targetId);

  return (
    <aside className="studio" aria-labelledby="role-studio-title">
      <header className="studio-head">
        <div className="eyebrow"><Icon name="roles" /> Policy authoring</div>
        <h2 id="role-studio-title">Role studio</h2>
        <p>Translate a business need into a scoped request. No access changes until both a Data Owner and Governance Admin approve the same frozen draft.</p>
      </header>

      <section className="ask-panel" aria-labelledby="ask-title">
        <div className="section-kicker" id="ask-title">Start with a need</div>
        <label htmlFor={askId}>Access requirement</label>
        <textarea
          id={askId}
          data-testid="need-ask"
          rows={3}
          placeholder="Example: L1 support can view process-chain health, without vendor PII"
          value={ask}
          onChange={(event) => setAsk(event.target.value)}
        />
        <button
          className="btn secondary full"
          type="button"
          disabled={generating || !ask.trim()}
          onClick={() => onGenerate(ask.trim())}
        >
          <Icon name="spark" />
          {generating ? "Generating draft…" : "Generate a least-privilege draft"}
        </button>
        {rationale.length > 0 && (
          <details className="rationale">
            <summary>Why these controls were selected</summary>
            <ul>
              {rationale.map((line, index) => <li key={`${line}-${index}`}>{line}</li>)}
            </ul>
          </details>
        )}
      </section>

      <div className="field">
        <label htmlFor={nameId}>Role name</label>
        <input
          id={nameId}
          type="text"
          placeholder="Example: EU finance analyst"
          value={draft.name}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          aria-invalid={!draft.name.trim()}
        />
      </div>

      <section className="palette" data-testid="palette" aria-labelledby="palette-title">
        <div className="section-kicker" id="palette-title">Policy controls</div>
        {!palette ? (
          <div className="skeleton-stack" aria-label="Loading policy controls">
            <span /><span /><span />
          </div>
        ) : groups.map((group) => (
          <fieldset key={group.title} className="palette-group">
            <legend>{group.title}</legend>
            <div className="token-row">
              {group.tokens.map((token) => {
                const active = isActive(draft, token);
                return (
                  <button
                    key={`${token.group}-${token.id}`}
                    type="button"
                    className={`token ${active ? "on" : ""}`}
                    aria-pressed={active}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData("application/cca-token", JSON.stringify(token));
                      event.dataTransfer.effectAllowed = "copy";
                    }}
                    onClick={() => onChange(applyToken(draft, token))}
                  >
                    {active && <Icon name="check" />}
                    {token.label}
                  </button>
                );
              })}
            </div>
          </fieldset>
        ))}
      </section>

      <section className="wells" data-testid="role-canvas" aria-labelledby="canvas-title">
        <div className="section-kicker" id="canvas-title">Effective role definition</div>
        {WELLS.map((well) => (
          <DropWell
            key={well.key}
            well={well}
            tokens={tokensInWell(draft, well.key, palette)}
            onDropToken={(token) => onChange(applyToken(draft, token))}
            onRemove={(id) => onChange(removeToken(draft, well.group, id))}
          />
        ))}
      </section>

      <footer className="studio-actions">
        <div className="validation-box" data-state={validationErrors.length ? "invalid" : "valid"} aria-live="polite">
          <Icon name={validationErrors.length ? "warning" : "check"} />
          <div>
            <b>{validationErrors.length ? `${validationErrors.length} item${validationErrors.length === 1 ? "" : "s"} to resolve` : "Draft is ready to review"}</b>
            {validationErrors.length > 0 && (
              <ul>{validationErrors.map((error) => <li key={error}>{error}</li>)}</ul>
            )}
          </div>
        </div>
        {requestMode === "governed" ? (
          <div className="field">
            <label htmlFor={targetIdLabel}>Target user</label>
            <select id={targetIdLabel} value={targetId} onChange={(event) => onTargetChange(event.target.value)}>
              {targets.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.displayName} · {candidate.username}
                  </option>
                ))}
            </select>
          </div>
        ) : (
          <div className="request-target" aria-label="Role request target"><span>Target user</span><b>{principal.displayName}</b><small>{principal.username} · self-service request</small></div>
        )}
        <div className="managed-boundary" aria-label="Generated policy boundary">
          <span><Icon name="capsule" /><b>Generated policy boundary</b></span>
          <code>{managedCapsuleId}</code>
          <small>Deterministic from purpose and row scope. The final managed capsule is created only after both required approvals.</small>
        </div>
        <button
          className="btn primary full"
          disabled={!previewReady || previewing || validationErrors.length > 0 || !validTarget}
          onClick={() => onReview(targetId)}
        >
          <Icon name="shield" />
          {previewing ? "Refreshing impact…" : "Review role request"}
        </button>
      </footer>
    </aside>
  );
}

function DropWell({
  well,
  tokens,
  onDropToken,
  onRemove,
}: {
  well: { key: WellKey; title: string; hint: string; group: string };
  tokens: RoleToken[];
  onDropToken: (token: RoleToken) => void;
  onRemove: (id: string) => void;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={`well ${tokens.length ? "filled" : ""} ${over ? "drag-over" : ""}`}
      aria-label={`${well.title}. ${well.hint}`}
      onDragEnter={() => setOver(true)}
      onDragLeave={() => setOver(false)}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        const raw = event.dataTransfer.getData("application/cca-token");
        if (!raw) return;
        try {
          const token = JSON.parse(raw) as RoleToken;
          if (token.group === well.group) onDropToken(token);
        } catch {
          // Ignore malformed drag payloads from outside the application.
        }
      }}
    >
      <div className="well-label">
        <b>{well.title}</b>
        <small>{well.hint}</small>
      </div>
      <div className="token-row">
        {tokens.length === 0 && <span className="drop-hint">Choose above or drag here</span>}
        {tokens.map((token) => (
          <button
            key={token.id}
            type="button"
            className="token on removable"
            aria-label={`Remove ${token.label} from ${well.title}`}
            onClick={() => onRemove(token.id)}
          >
            {token.label}<Icon name="close" />
          </button>
        ))}
      </div>
    </div>
  );
}

function isActive(draft: RoleDraft, token: RoleToken): boolean {
  switch (token.group) {
    case "verb": return draft.verbs.includes(token.id);
    case "purpose": return draft.purpose === token.id;
    case "ceiling": return draft.ceiling === token.id;
    case "product": return draft.products.includes(token.id);
    case "tenant": return draft.tenants.includes(token.id);
    case "region": return draft.regions.includes(token.id);
    case "department": return draft.departments.includes(token.id);
    case "mask": return draft.denyFields.includes(token.id);
    case "source": return draft.sources.includes(token.id);
    default: return false;
  }
}

function tokensInWell(draft: RoleDraft, key: WellKey, palette: RolePalette | null): RoleToken[] {
  if (!palette) return [];
  const lookup = (list: RoleToken[], ids: string[], group: string) =>
    ids.map((id) => list.find((token) => token.id === id) ?? {
      id,
      label: `Unsupported: ${id}`,
      group,
    });
  switch (key) {
    case "verbs": return lookup(palette.verbs, draft.verbs, "verb");
    case "purpose": return lookup(palette.purposes, draft.purpose ? [draft.purpose] : [], "purpose");
    case "ceiling": return lookup(palette.ceilings, [draft.ceiling], "ceiling");
    case "products": return lookup(palette.products, draft.products, "product");
    case "tenants": return lookup(palette.tenants, draft.tenants, "tenant");
    case "regions": return lookup(palette.regions, draft.regions, "region");
    case "departments": return lookup(palette.departments, draft.departments, "department");
    case "masks": return lookup(palette.masks, draft.denyFields, "mask");
    case "sources": return lookup(palette.sources ?? [], draft.sources, "source");
    default: return [];
  }
}
