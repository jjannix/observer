import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import type { SanitizedConfig } from "@shared/contracts";

export function Settings() {
  const qc = useQueryClient();
  const { data: config } = useQuery({ queryKey: ["config"], queryFn: api.config });

  const syncMut = useMutation({ mutationFn: api.sync, onSuccess: () => qc.invalidateQueries() });
  const renormMut = useMutation({ mutationFn: api.renormalize, onSuccess: () => qc.invalidateQueries() });
  const rebuildMut = useMutation({ mutationFn: api.rebuild, onSuccess: () => qc.invalidateQueries() });
  const [confirmRebuild, setConfirmRebuild] = useState(false);

  return (
    <div style={{ maxWidth: 880 }}>
      <div className="page-head">
        <div className="titles">
          <h1>Settings</h1>
          <p className="page-sub">Sources, history cutoff, alias rules, and maintenance.</p>
        </div>
      </div>

      {!config ? (
        <div className="surface pad"><div className="skeleton" style={{ height: 120 }} /></div>
      ) : (
        <div className="stack">
          <section className="surface pad">
            <div className="section-head"><h2>Configuration</h2></div>
            <div className="kvs">
              <dt>Config file</dt><dd>{config.configPath}</dd>
              <dt>Data directory</dt><dd>{config.dataDir}</dd>
              <dt>Database</dt><dd>{config.dbPath}</dd>
              <dt>Time zone</dt><dd>{config.timezone}</dd>
            </div>
          </section>

          <SourcesEditor config={config} />
          <GeneralEditor config={config} />
          <AliasesEditor config={config} />

          <section className="surface pad">
            <div className="section-head"><h2>Actions</h2></div>
            <div className="row wrap">
              <button onClick={() => syncMut.mutate()} disabled={syncMut.isPending}>
                {syncMut.isPending ? <span className="spinner" /> : null} Sync now
              </button>
              <button onClick={() => renormMut.mutate()} disabled={renormMut.isPending}>
                {renormMut.isPending ? <span className="spinner" /> : null} Re-normalize
              </button>
              <button className="danger" onClick={() => setConfirmRebuild(true)} disabled={rebuildMut.isPending}>
                {rebuildMut.isPending ? <span className="spinner" /> : null} Rebuild index
              </button>
            </div>
            <p className="dim" style={{ marginTop: "var(--space-3)", fontSize: 11.5 }}>
              Re-normalize re-resolves canonical dimensions from retained envelopes (no rescan).
              Rebuild clears Observer storage and rescans sources. Neither touches harness data.
            </p>
          </section>
        </div>
      )}

      {confirmRebuild && (
        <div className="dialog-overlay" onClick={() => setConfirmRebuild(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Rebuild index?</h3>
            <p>This clears Observer's index and rescans all sources. Your harness data is never modified. The app may be briefly unresponsive during the rescan.</p>
            <div className="actions">
              <button className="ghost" onClick={() => setConfirmRebuild(false)}>Cancel</button>
              <button className="danger" onClick={() => { rebuildMut.mutate(); setConfirmRebuild(false); }}>
                Rebuild
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SourcesEditor({ config }: { config: SanitizedConfig }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (next: SanitizedConfig) => api.updateConfig(toPayload(next)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["config"] }),
  });
  const [local, setLocal] = useState<SanitizedConfig>(config);
  const dirty = JSON.stringify(local.sources) !== JSON.stringify(config.sources);

  return (
    <section className="surface pad">
      <div className="section-head">
        <h2>Sources</h2>
        <button className="primary sm" disabled={!dirty || save.isPending} onClick={() => save.mutate(local)}>
          {save.isPending ? <span className="spinner" /> : null} Save
        </button>
      </div>
      <div className="stack">
        {local.sources.map((s, i) => (
          <div key={s.id} className="row">
            <label className="row" style={{ gap: 8, minWidth: 150, textTransform: "none", letterSpacing: 0 }}>
              <input
                type="checkbox"
                checked={s.enabled}
                onChange={(e) => patch(local, setLocal, (next) => { next.sources[i] = { ...s, enabled: e.target.checked }; })}
              />
              <span style={{ color: "var(--fg-0)", textTransform: "none", letterSpacing: 0 }}>{s.label}</span>
            </label>
            <span className="badge">{s.harness}</span>
            {!s.present && <span className="badge danger">missing</span>}
            <input
              className="mono"
              style={{ flex: 1 }}
              value={s.root}
              onChange={(e) => patch(local, setLocal, (next) => { next.sources[i] = { ...s, root: e.target.value }; })}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function GeneralEditor({ config }: { config: SanitizedConfig }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (next: SanitizedConfig) => api.updateConfig(toPayload(next)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["config"] }),
  });
  const [local, setLocal] = useState<SanitizedConfig>(config);
  const [cutoff, setCutoff] = useState<string>(config.historyCutoff?.slice(0, 10) ?? "");
  const dirtyCutoff = (cutoff ? new Date(cutoff).toISOString() : null) !== config.historyCutoff;
  const dirtyInterval = local.syncIntervalSeconds !== config.syncIntervalSeconds;
  const dirty = dirtyCutoff || dirtyInterval;

  return (
    <section className="surface pad">
      <div className="section-head">
        <h2>History cutoff &amp; sync interval</h2>
        <button className="primary sm" disabled={!dirty || save.isPending} onClick={() => {
          const next = { ...local, historyCutoff: cutoff ? new Date(cutoff).toISOString() : null };
          setLocal(next);
          save.mutate(next);
        }}>
          {dirtyCutoff ? "Save & rebuild" : "Save"}
        </button>
      </div>
      <div className="kvs">
        <dt>History cutoff</dt>
        <dd>
          <div className="row">
            <input type="date" value={cutoff} style={{ width: "auto" }} onChange={(e) => setCutoff(e.target.value)} />
            {dirtyCutoff && <span className="dim" style={{ fontSize: 11 }}>requires save &amp; rebuild</span>}
          </div>
        </dd>
        <dt>Sync interval</dt>
        <dd>
          <div className="row">
            <input type="number" min={5} style={{ width: "auto" }} value={local.syncIntervalSeconds}
              onChange={(e) => setLocal({ ...local, syncIntervalSeconds: Number(e.target.value) || 60 })} />
            <span className="dim" style={{ fontSize: 11 }}>seconds</span>
          </div>
        </dd>
      </div>
    </section>
  );
}

function AliasesEditor({ config }: { config: SanitizedConfig }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (next: SanitizedConfig) => api.updateConfig(toPayload(next)),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["config"] }); qc.invalidateQueries({ queryKey: ["summary"] }); },
  });
  const [local, setLocal] = useState<SanitizedConfig>(config);
  const dirty = JSON.stringify({ a: local.providerAliases, b: local.modelAliases, c: local.projectAliases }) !==
    JSON.stringify({ a: config.providerAliases, b: config.modelAliases, c: config.projectAliases });

  return (
    <section className="surface pad">
      <div className="section-head">
        <h2>Aliases</h2>
        <button className="primary sm" disabled={!dirty || save.isPending} onClick={() => { save.mutate(local); }}>
          {save.isPending ? <span className="spinner" /> : null} Save &amp; re-normalize
        </button>
      </div>
      <p className="dim" style={{ fontSize: 11.5, marginBottom: "var(--space-3)" }}>
        Saving re-resolves canonical dimensions from retained envelopes without rescanning sources.
      </p>
      <AliasGroup
        title="Provider display aliases"
        items={local.providerAliases.map((a) => ({ key: a.raw, value: a.display }))}
        keyLabel="Raw" valueLabel="Display"
        onChange={(items) => setLocal({ ...local, providerAliases: items.map((i) => ({ raw: i.key, display: i.value })) })}
      />
      <AliasGroup
        title="Model aliases"
        items={local.modelAliases.map((a) => ({ key: `${a.owner ?? "*"}/${a.model}`, value: a.canonicalModel }))}
        keyLabel="Owner / Model" valueLabel="Canonical"
        onChange={(items) => setLocal({
          ...local,
          modelAliases: items.map((i) => {
            const slash = i.key.indexOf("/");
            const owner = slash > 0 ? i.key.slice(0, slash) : "";
            const model = slash > 0 ? i.key.slice(slash + 1) : i.key;
            return { provider: null, model, canonicalModel: i.value, owner: owner === "*" || !owner ? null : owner };
          }),
        })}
      />
      <AliasGroup
        title="Project aliases"
        items={local.projectAliases.map((a) => ({ key: a.paths.join(";"), value: a.canonicalProject }))}
        keyLabel="Paths (;)" valueLabel="Canonical project"
        onChange={(items) => setLocal({
          ...local,
          projectAliases: items.map((i) => ({ paths: i.key.split(";").map((s) => s.trim()).filter(Boolean), canonicalProject: i.value })),
        })}
      />
    </section>
  );
}

function AliasGroup({
  title, items, onChange, keyLabel, valueLabel,
}: {
  title: string;
  items: { key: string; value: string }[];
  onChange: (items: { key: string; value: string }[]) => void;
  keyLabel: string;
  valueLabel: string;
}) {
  const [k, setK] = useState("");
  const [v, setV] = useState("");
  return (
    <details style={{ marginTop: "var(--space-2)" }}>
      <summary className="muted" style={{ cursor: "pointer", padding: "4px 0" }}>{title} ({items.length})</summary>
      <div style={{ marginTop: "var(--space-2)" }}>
        {items.length > 0 && (
          <table className="data" style={{ marginBottom: "var(--space-2)" }}>
            <thead><tr><th>{keyLabel}</th><th>{valueLabel}</th><th></th></tr></thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i}>
                  <td className="tmono">{it.key}</td>
                  <td className="tmono">{it.value}</td>
                  <td><button className="ghost sm" onClick={() => onChange(items.filter((_, idx) => idx !== i))}>remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="row">
          <input placeholder={keyLabel} value={k} onChange={(e) => setK(e.target.value)} />
          <input placeholder={valueLabel} value={v} onChange={(e) => setV(e.target.value)} />
          <button className="sm" onClick={() => { if (k && v) { onChange([...items, { key: k, value: v }]); setK(""); setV(""); } }}>Add</button>
        </div>
      </div>
    </details>
  );
}

function patch(cfg: SanitizedConfig, set: (c: SanitizedConfig) => void, fn: (draft: SanitizedConfig) => void): void {
  const next: SanitizedConfig = JSON.parse(JSON.stringify(cfg));
  fn(next);
  set(next);
}

function toPayload(s: SanitizedConfig): unknown {
  return {
    version: s.version,
    timezone: s.timezone,
    syncIntervalSeconds: s.syncIntervalSeconds,
    historyCutoff: s.historyCutoff,
    sources: s.sources.map((src) => ({ id: src.id, harness: src.harness, label: src.label, root: src.root, enabled: src.enabled })),
    providerAliases: s.providerAliases,
    providerOverrides: s.providerOverrides.map((o) => ({
      harness: o.harness, rawProviderId: o.rawProviderId, rawModelId: o.rawModelId,
      canonicalProviderId: o.canonicalProviderId, from: o.from, to: o.to,
    })),
    modelAliases: s.modelAliases.map((m) => ({ provider: m.provider, model: m.model, canonicalModel: m.canonicalModel, owner: m.owner })),
    projectAliases: s.projectAliases,
  };
}
