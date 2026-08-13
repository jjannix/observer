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
    <div ref={ref} className="multi-select" style={{ width }}>
      <button
        className={`multi-select-trigger${selected.length ? " has-value" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="multi-select-label">{label}</span>
        <span className="multi-select-value">
          {selected.length === 0 ? "All" : selected.length === 1 ? options.find((o) => o.id === selected[0])?.label ?? "1" : `${selected.length}`}
        </span>
        <span className="multi-select-chevron" aria-hidden="true" />
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
