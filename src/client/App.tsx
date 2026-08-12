import { NavLink, Outlet, Link } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useHealth } from "./api.js";
import { api } from "./api.js";

export function App() {
  const { health } = useHealth();
  const active = health?.activeSync?.runId;
  const warnings = health?.warningCount ?? 0;
  const { data: sources } = useQuery({ queryKey: ["sources"], queryFn: api.sources, refetchInterval: 3000 });
  const sync = useMutation({ mutationFn: api.sync });
  const presentSources = sources?.filter((source) => source.present).length ?? 0;
  const sourceCount = sources?.length ?? 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="mark" />
          <span>Observer</span>
          <span className="brand-badge">LOCAL</span>
        </div>
        <nav className="topnav" aria-label="Primary navigation">
          <NavLink to="/" end className={({ isActive }) => "navlink" + (isActive ? " active" : "")}>
            <Icon name="overview" />
            <span>Overview</span>
          </NavLink>
          <NavLink to="/events" className={({ isActive }) => "navlink" + (isActive ? " active" : "")}>
            <Icon name="events" />
            <span>Events</span>
            <span className="nav-count">{health?.warningCount ? warnings : ""}</span>
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => "navlink" + (isActive ? " active" : "")}>
            <Icon name="settings" />
            <span>Settings</span>
          </NavLink>
        </nav>
        <div className="topbar-spacer" />
        <div className="topbar-status">
          <Link to="/settings" className="top-health">
            <span className={`health-dot ${warnings > 0 ? "warn" : "ok"}`} />
            <span>{sourceCount ? `${presentSources}/${sourceCount} sources` : "No sources"}</span>
          </Link>
          {warnings > 0 && <span className="top-warning">{warnings} warnings</span>}
          <button className="top-sync" onClick={() => sync.mutate()} disabled={sync.isPending || !!active}>
            {active ? <span className="spinner" /> : <Icon name="sync" />}
            <span>{active ? "Syncing" : "Sync"}</span>
          </button>
        </div>
      </header>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}

function Icon({ name }: { name: "overview" | "events" | "settings" | "sync" }) {
  const paths = {
    overview: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    events: <><path d="M4 5h16M4 12h16M4 19h10" /><circle cx="19" cy="19" r="2" /></>,
    settings: <><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /><circle cx="12" cy="12" r="3.5" /></>,
    sync: <><path d="M20 11a8 8 0 0 0-14.8-3L3 11" /><path d="M3 5v6h6" /><path d="M4 13a8 8 0 0 0 14.8 3L21 13" /><path d="M21 19v-6h-6" /></>,
  };
  return <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
