import { NavLink, Outlet } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useHealth } from "./api.js";
import { api } from "./api.js";

export function App() {
  const queryClient = useQueryClient();
  const { health } = useHealth();
  const active = health?.activeSync?.runId;
  const { data: sources } = useQuery({ queryKey: ["sources"], queryFn: api.sources, refetchInterval: 3000 });
  const sync = useMutation({
    mutationFn: api.sync,
    onSuccess: () => queryClient.invalidateQueries(),
  });
  const latestSync = sources
    ?.map((source) => source.lastSyncFinishedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <NavLink to="/" className="brand" aria-label="Observer overview">
            <span className="mark" aria-hidden="true"><span /></span>
            <span>Observer</span>
          </NavLink>
          <nav className="topnav" aria-label="Primary navigation">
            <NavLink to="/" end className={({ isActive }) => "navlink" + (isActive ? " active" : "")}>
              <span>Overview</span>
            </NavLink>
            <NavLink to="/sessions" className={({ isActive }) => "navlink" + (isActive ? " active" : "")}>
              <span>Sessions</span>
            </NavLink>
            <NavLink to="/analysis" className={({ isActive }) => "navlink" + (isActive ? " active" : "")}>
              <span>Analysis</span>
            </NavLink>
          </nav>
          <div className="topbar-spacer" />
          <div className="topbar-status">
            <span className="last-sync">{active ? "Observing sources" : relativeSync(latestSync)}</span>
            <button className="top-sync" aria-label="Sync now" onClick={() => sync.mutate()} disabled={sync.isPending || !!active}>
              {active ? <span className="spinner" /> : <Icon name="sync" />}
              <span>{active ? "Syncing" : "Sync"}</span>
            </button>
            <NavLink to="/settings" className={({ isActive }) => "settings-link" + (isActive ? " active" : "")} aria-label="Settings">
              <Icon name="settings" />
            </NavLink>
          </div>
        </div>
      </header>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}

function relativeSync(iso: string | undefined): string {
  if (!iso) return "Not synced yet";
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "Synced just now";
  if (minutes < 60) return `Synced ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Synced ${hours}h ago`;
  return `Synced ${Math.round(hours / 24)}d ago`;
}

function Icon({ name }: { name: "sync" | "settings" }) {
  const paths = {
    sync: <><path d="M20 11a8 8 0 0 0-14.8-3L3 11" /><path d="M3 5v6h6" /><path d="M4 13a8 8 0 0 0 14.8 3L21 13" /><path d="M21 19v-6h-6" /></>,
    settings: <><circle cx="12" cy="12" r="3.2" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-1.86 1.86-.06-.06A1.7 1.7 0 0 0 16 18.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V20h-2.6v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.88.34l-.06.06-1.86-1.86.06-.06A1.7 1.7 0 0 0 7.5 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H5.7V11h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.34-1.88L7 7.96 8.86 6.1l.06.06A1.7 1.7 0 0 0 10.8 6.5a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V4.7h2.6v.1a1.7 1.7 0 0 0 1.1 1.6 1.7 1.7 0 0 0 1.88-.34l.06-.06 1.86 1.86-.06.06A1.7 1.7 0 0 0 19.3 9.8a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1.1.4h.1v2.6H21a1.7 1.7 0 0 0-1.6 1.2Z" /></>,
  };
  return <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
