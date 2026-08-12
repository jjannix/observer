import { useEffect, useRef, useState } from "react";

export interface Option {
  id: string;
  label: string;
  count?: number;
}

interface Props {
  label: string;
  options: Option[];
  selected: string[];
  onChange: (next: string[]) => void;
  width?: number;
}

export function MultiSelect({ label, options, selected, onChange, width = 200 }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const filtered = options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase()));
  const allVisibleSelected = filtered.length > 0 && filtered.every((o) => selected.includes(o.id));

  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };

  return (
    <div ref={ref} style={{ position: "relative", width }}>
      <button
        className="ghost"
        onClick={() => setOpen((o) => !o)}
        style={{ width: "100%", justifyContent: "flex-start", gap: 8, color: selected.length ? "var(--fg-0)" : "var(--fg-2)" }}
      >
        <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.02, color: "var(--fg-3)" }}>{label}</span>
        <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 12 }}>
          {selected.length === 0 ? "All" : selected.length === 1 ? options.find((o) => o.id === selected[0])?.label ?? "1" : `${selected.length}`}
        </span>
      </button>
      {open && (
        <div className="popover">
          <div className="search">
            <input autoFocus placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="options">
            {filtered.map((o) => (
              <label key={o.id} className={`opt ${selected.includes(o.id) ? "active" : ""}`}>
                <input type="checkbox" checked={selected.includes(o.id)} onChange={() => toggle(o.id)} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.label}</span>
                {o.count != null && <span className="count">{o.count}</span>}
              </label>
            ))}
            {filtered.length === 0 && <div className="dim" style={{ padding: 8, fontSize: 12 }}>No matches.</div>}
          </div>
          <div className="foot">
            <button className="ghost sm" onClick={() => onChange(filtered.length ? filtered.map((o) => o.id) : [])}>
              {allVisibleSelected ? "Clear" : "All"}
            </button>
            <button className="ghost sm" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}
