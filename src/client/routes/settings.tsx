import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import type { SanitizedConfig } from "@shared/contracts";

type AliasItem = { key: string; value: string };

export function Settings() {
  const qc = useQueryClient();
  const { data: config } = useQuery({ queryKey: ["config"], queryFn: api.config });

  const syncMut = useMutation({ mutationFn: api.sync, onSuccess: () => qc.invalidateQueries() });
  const renormMut = useMutation({ mutationFn: api.renormalize, onSuccess: () => qc.invalidateQueries() });
  const rebuildMut = useMutation({ mutationFn: api.rebuild, onSuccess: () => qc.invalidateQueries() });
  const [confirmRebuild, setConfirmRebuild] = useState(false);

  return (
    <div className="settings-page">
      <div className="page-head settings-page-head">
        <div className="titles">
          <h1>Settings</h1>
          <p className="page-sub">Manage Observer's local sources, collection, and naming rules.</p>
        </div>
      </div>

      {!config ? (
        <div className="surface pad"><div className="skeleton" style={{ height: 120 }} /></div>
      ) : (
        <div className="settings-sections">
          <SystemInformation config={config} />
          <SourcesEditor config={config} />
          <GeneralEditor config={config} />
          <AliasesEditor config={config} />

          <section className="settings-section" aria-labelledby="data-maintenance-heading">
            <div className="settings-section-head">
              <div>
                <h2 id="data-maintenance-heading">Data maintenance</h2>
                <p>Refresh or rebuild Observer's local data when needed.</p>
              </div>
            </div>
            <div className="maintenance-actions">
              <button onClick={() => syncMut.mutate()} disabled={syncMut.isPending}>
                {syncMut.isPending ? <span className="spinner" /> : <ActionIcon name="sync" />} Sync now
              </button>
              <button onClick={() => renormMut.mutate()} disabled={renormMut.isPending}>
                {renormMut.isPending ? <span className="spinner" /> : <ActionIcon name="refresh" />} Reapply aliases
              </button>
              <button className="danger" aria-label="Rebuild index" onClick={() => setConfirmRebuild(true)} disabled={rebuildMut.isPending}>
                {rebuildMut.isPending ? <span className="spinner" /> : <ActionIcon name="rebuild" />} Rebuild local index
              </button>
            </div>
            <p className="settings-note">
              Sync imports new records. Reapplying aliases updates existing sessions from saved rules. Rebuilding clears only Observer's index, then scans enabled sources again.
            </p>
          </section>
        </div>
      )}

      {confirmRebuild && (
        <div className="dialog-overlay" onClick={() => setConfirmRebuild(false)}>
          <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="rebuild-title" onClick={(e) => e.stopPropagation()}>
            <h3 id="rebuild-title">Rebuild local index?</h3>
            <p>This clears Observer's index and rescans all enabled sources. Your source files are never modified. Observer may be briefly unavailable during the scan.</p>
            <div className="actions">
              <button className="ghost" onClick={() => setConfirmRebuild(false)}>Cancel</button>
              <button className="danger" onClick={() => { rebuildMut.mutate(); setConfirmRebuild(false); }}>
                Rebuild index
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SystemInformation({ config }: { config: SanitizedConfig }) {
  return (
    <section className="settings-section" aria-labelledby="configuration-heading">
      <div className="settings-section-head">
        <div>
          <h2 id="configuration-heading">Configuration</h2>
          <p>Read-only information about this Observer installation.</p>
        </div>
      </div>
      <dl className="system-info">
        <SystemRow label="Config file" value={config.configPath} />
        <SystemRow label="Data directory" value={config.dataDir} />
        <SystemRow label="Database path" value={config.dbPath} />
        <SystemRow label="Time zone" value={config.timezone} />
      </dl>
    </section>
  );
}

function SystemRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="system-row">
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
      <button className="ghost sm system-action" onClick={copy} aria-label={`Copy ${label.toLowerCase()}`}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function SourcesEditor({ config }: { config: SanitizedConfig }) {
  const qc = useQueryClient();
  const [local, setLocal] = useState<SanitizedConfig>(config);
  const save = useMutation({
    mutationFn: (next: SanitizedConfig) => api.updateConfig(toPayload(next)),
    onSuccess: (saved) => {
      setLocal(saved);
      qc.invalidateQueries({ queryKey: ["config"] });
    },
  });
  const editableSources = (value: SanitizedConfig) => value.sources.map((source) => ({
    id: source.id,
    root: source.root,
    enabled: source.enabled,
  }));
  const dirty = JSON.stringify(editableSources(local)) !== JSON.stringify(editableSources(config));

  return (
    <section className="settings-section" aria-labelledby="sources-heading">
      <div className="settings-section-head">
        <div>
          <h2 id="sources-heading">Sources</h2>
          <p>Choose which local session directories Observer reads.</p>
        </div>
      </div>

      <div className="source-list" role="table" aria-label="Local session sources">
        <div className="source-list-head" role="row">
          <span role="columnheader">Enabled</span>
          <span role="columnheader">Source</span>
          <span role="columnheader">Location</span>
        </div>
        {local.sources.map((source, index) => (
          <div key={source.id} className="source-row" role="row">
            <div className="source-enabled" role="cell">
              <input
                type="checkbox"
                checked={source.enabled}
                aria-label={`${source.enabled ? "Disable" : "Enable"} ${source.label}`}
                onChange={(event) => patch(local, setLocal, (next) => {
                  next.sources[index] = { ...source, enabled: event.target.checked };
                })}
              />
            </div>
            <div className="source-name" role="cell">
              <span>{source.label}</span>
              {!source.present && <small>Folder not found</small>}
            </div>
            <div className="source-location" role="cell">
              <input
                className="mono"
                aria-label={`${source.label} location`}
                value={source.root}
                spellCheck={false}
                onChange={(event) => patch(local, setLocal, (next) => {
                  next.sources[index] = { ...source, root: event.target.value };
                })}
              />
            </div>
          </div>
        ))}
      </div>

      {dirty && (
        <SectionActions
          pending={save.isPending}
          error={save.isError}
          onDiscard={() => setLocal(config)}
          onSave={() => save.mutate({ ...config, sources: local.sources })}
        />
      )}
    </section>
  );
}

function GeneralEditor({ config }: { config: SanitizedConfig }) {
  const qc = useQueryClient();
  const [local, setLocal] = useState<SanitizedConfig>(config);
  const save = useMutation({
    mutationFn: async ({ next, rebuild }: { next: SanitizedConfig; rebuild: boolean }) => {
      const saved = await api.updateConfig(toPayload(next));
      if (rebuild) await api.rebuild();
      return saved;
    },
    onSuccess: (saved) => {
      setLocal(saved);
      qc.invalidateQueries();
    },
  });
  const [cutoff, setCutoff] = useState(config.historyCutoff?.slice(0, 10) ?? "");
  const cutoffIso = cutoff ? new Date(cutoff).toISOString() : null;
  const dirtyCutoff = cutoffIso !== config.historyCutoff;
  const dirtyInterval = local.syncIntervalSeconds !== config.syncIntervalSeconds;
  const dirty = dirtyCutoff || dirtyInterval;
  const discard = () => {
    setLocal(config);
    setCutoff(config.historyCutoff?.slice(0, 10) ?? "");
  };
  const submit = () => {
    const next = {
      ...config,
      syncIntervalSeconds: local.syncIntervalSeconds,
      historyCutoff: cutoffIso,
    };
    setLocal(next);
    save.mutate({ next, rebuild: dirtyCutoff });
  };

  return (
    <section className="settings-section" aria-labelledby="data-collection-heading">
      <div className="settings-section-head">
        <div>
          <h2 id="data-collection-heading">Data collection</h2>
          <p>Control how much history Observer includes and how often it refreshes.</p>
        </div>
      </div>

      <div className="setting-rows">
        <div className="setting-row">
          <div className="setting-copy">
            <label htmlFor="history-cutoff">History cutoff</label>
            <p>Ignore sessions recorded before this date.</p>
          </div>
          <div className="setting-control cutoff-control">
            <input id="history-cutoff" type="date" value={cutoff} onChange={(event) => setCutoff(event.target.value)} />
            {cutoff ? (
              <button className="ghost sm" onClick={() => setCutoff("")}>Clear</button>
            ) : (
              <span className="control-state">No cutoff</span>
            )}
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-copy">
            <label htmlFor="sync-interval">Sync interval</label>
            <p>How often Observer checks enabled sources for new sessions.</p>
          </div>
          <div className="setting-control interval-control">
            <span>Refresh local sources every</span>
            <input
              id="sync-interval"
              type="number"
              min={5}
              max={86400}
              inputMode="numeric"
              value={local.syncIntervalSeconds}
              onChange={(event) => setLocal({ ...local, syncIntervalSeconds: Number(event.target.value) || 60 })}
            />
            <span>seconds</span>
          </div>
        </div>
      </div>

      {dirtyCutoff && <p className="settings-note">Changing the cutoff rebuilds Observer's local index. Your source files are not modified.</p>}
      {dirty && (
        <SectionActions
          pending={save.isPending}
          error={save.isError}
          saveLabel={dirtyCutoff ? "Save & rebuild" : "Save changes"}
          onDiscard={discard}
          onSave={submit}
        />
      )}
    </section>
  );
}

function AliasesEditor({ config }: { config: SanitizedConfig }) {
  const qc = useQueryClient();
  const [local, setLocal] = useState<SanitizedConfig>(config);
  const save = useMutation({
    mutationFn: async (next: SanitizedConfig) => {
      const saved = await api.updateConfig(toPayload(next));
      await api.renormalize();
      return saved;
    },
    onSuccess: (saved) => {
      setLocal(saved);
      qc.invalidateQueries();
    },
  });
  const dirty = JSON.stringify({ a: local.providerAliases, b: local.modelAliases, c: local.projectAliases }) !==
    JSON.stringify({ a: config.providerAliases, b: config.modelAliases, c: config.projectAliases });

  return (
    <section className="settings-section" aria-labelledby="aliases-heading">
      <div className="settings-section-head">
        <div>
          <h2 id="aliases-heading">Aliases</h2>
          <p>Normalize provider, model, and project names across different coding agents.</p>
        </div>
      </div>

      <div className="alias-groups">
        <AliasGroup
          title="Provider aliases"
          items={local.providerAliases.map((alias) => ({ key: alias.raw, value: alias.display }))}
          keyLabel="Provider name"
          valueLabel="Display as"
          onChange={(items) => setLocal({ ...local, providerAliases: items.map((item) => ({ raw: item.key, display: item.value })) })}
        />
        <AliasGroup
          title="Model aliases"
          items={local.modelAliases.map((alias) => ({ key: `${alias.owner ?? "*"}/${alias.model}`, value: alias.canonicalModel }))}
          keyLabel="Owner / model"
          valueLabel="Canonical name"
          onChange={(items) => setLocal({
            ...local,
            modelAliases: items.map((item) => {
              const slash = item.key.indexOf("/");
              const owner = slash > 0 ? item.key.slice(0, slash) : "";
              const model = slash > 0 ? item.key.slice(slash + 1) : item.key;
              return { provider: null, model, canonicalModel: item.value, owner: owner === "*" || !owner ? null : owner };
            }),
          })}
        />
        <AliasGroup
          title="Project aliases"
          items={local.projectAliases.map((alias) => ({ key: alias.paths.join(";"), value: alias.canonicalProject }))}
          keyLabel="Paths (separate with ;)"
          valueLabel="Project name"
          onChange={(items) => setLocal({
            ...local,
            projectAliases: items.map((item) => ({
              paths: item.key.split(";").map((path) => path.trim()).filter(Boolean),
              canonicalProject: item.value,
            })),
          })}
        />
      </div>

      {dirty && (
        <>
          <p className="settings-note">Applying aliases updates existing sessions from Observer's retained local records. Sources are not rescanned.</p>
          <SectionActions
            pending={save.isPending}
            error={save.isError}
            saveLabel="Apply aliases"
            onDiscard={() => setLocal(config)}
            onSave={() => save.mutate({
              ...config,
              providerAliases: local.providerAliases,
              modelAliases: local.modelAliases,
              projectAliases: local.projectAliases,
            })}
          />
        </>
      )}
    </section>
  );
}

function AliasGroup({ title, items, onChange, keyLabel, valueLabel }: {
  title: string;
  items: AliasItem[];
  onChange: (items: AliasItem[]) => void;
  keyLabel: string;
  valueLabel: string;
}) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const add = () => {
    if (!key.trim() || !value.trim()) return;
    onChange([...items, { key: key.trim(), value: value.trim() }]);
    setKey("");
    setValue("");
  };

  return (
    <details className="alias-group">
      <summary>
        <span className="alias-group-title">{title}</span>
        <span className="alias-count">{items.length}</span>
        <span className="alias-chevron" aria-hidden="true" />
      </summary>
      <div className="alias-group-body">
        {items.length > 0 ? (
          <div className="table-scroll">
            <table className="data alias-table">
              <thead><tr><th>{keyLabel}</th><th>{valueLabel}</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {items.map((item, index) => (
                  <tr key={`${item.key}-${index}`}>
                    <td className="tmono">{item.key}</td>
                    <td className="tmono">{item.value}</td>
                    <td><button className="ghost sm" onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="alias-empty">No aliases in this group.</p>
        )}
        <div className="alias-add">
          <input aria-label={keyLabel} placeholder={keyLabel} value={key} onChange={(event) => setKey(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") add(); }} />
          <input aria-label={valueLabel} placeholder={valueLabel} value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") add(); }} />
          <button className="sm" disabled={!key.trim() || !value.trim()} onClick={add}>Add alias</button>
        </div>
      </div>
    </details>
  );
}

function SectionActions({ pending, error, onDiscard, onSave, saveLabel = "Save changes" }: {
  pending: boolean;
  error: boolean;
  onDiscard: () => void;
  onSave: () => void;
  saveLabel?: string;
}) {
  return (
    <div className="section-actions">
      <span className={error ? "section-action-status error" : "section-action-status"} role="status">
        {error ? "Changes could not be saved." : "Unsaved changes"}
      </span>
      <button className="ghost sm" onClick={onDiscard} disabled={pending}>Discard</button>
      <button className="primary sm" onClick={onSave} disabled={pending}>
        {pending ? <span className="spinner" /> : null} {pending ? "Saving" : saveLabel}
      </button>
    </div>
  );
}

function ActionIcon({ name }: { name: "sync" | "refresh" | "rebuild" }) {
  const paths = {
    sync: <><path d="M4 7h10" /><path d="m11 4 3 3-3 3" /><path d="M14 13H4" /><path d="m7 10-3 3 3 3" /></>,
    refresh: <><path d="M14.5 6A6 6 0 1 0 16 12" /><path d="M14.5 2v4h-4" /></>,
    rebuild: <><path d="M3 5h14" /><path d="M6 5V3h8v2" /><path d="m5 8 1 8h8l1-8" /></>,
  };
  return <svg className="button-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function patch(config: SanitizedConfig, set: (config: SanitizedConfig) => void, fn: (draft: SanitizedConfig) => void): void {
  const next: SanitizedConfig = JSON.parse(JSON.stringify(config));
  fn(next);
  set(next);
}

function toPayload(config: SanitizedConfig): unknown {
  return {
    version: config.version,
    timezone: config.timezone,
    syncIntervalSeconds: config.syncIntervalSeconds,
    historyCutoff: config.historyCutoff,
    sources: config.sources.map((source) => ({
      id: source.id,
      harness: source.harness,
      label: source.label,
      root: source.root,
      enabled: source.enabled,
    })),
    providerAliases: config.providerAliases,
    providerOverrides: config.providerOverrides.map((override) => ({
      harness: override.harness,
      rawProviderId: override.rawProviderId,
      rawModelId: override.rawModelId,
      canonicalProviderId: override.canonicalProviderId,
      from: override.from,
      to: override.to,
    })),
    modelAliases: config.modelAliases.map((model) => ({
      provider: model.provider,
      model: model.model,
      canonicalModel: model.canonicalModel,
      owner: model.owner,
    })),
    projectAliases: config.projectAliases,
  };
}
