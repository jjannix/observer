import { NavLink, Outlet } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useHealth } from "./api.js";
import { api } from "./api.js";
import { ObserverAperture } from "./components/ObserverAperture.js";

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
            <ObserverAperture className="mark" />
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
    sync: (
      <>
        <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
        <path d="M21 3v5h-5" />
        <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
        <path d="M8 16H3v5" />
      </>
    ),
    settings: (
      <>
        <path d="M9.67 4.14a2.34 2.34 0 0 1 4.66 0 2.34 2.34 0 0 0 3.32 1.91 2.34 2.34 0 0 1 2.33 4.03 2.34 2.34 0 0 0 0 3.84 2.34 2.34 0 0 1-2.33 4.03 2.34 2.34 0 0 0-3.32 1.91 2.34 2.34 0 0 1-4.66 0 2.34 2.34 0 0 0-3.32-1.91 2.34 2.34 0 0 1-2.33-4.03 2.34 2.34 0 0 0 0-3.84 2.34 2.34 0 0 1 2.33-4.03 2.34 2.34 0 0 0 3.32-1.91Z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
  };
  return <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}
