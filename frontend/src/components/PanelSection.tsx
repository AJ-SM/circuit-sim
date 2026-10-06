import { useState, type ReactNode } from "react";

const STORAGE_KEY = (id: string) => `panel-open:${id}`;

function readOpen(id: string): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY(id)) !== "0";
  } catch {
    return true;
  }
}

/** A right-sidebar section whose header toggles it open and closed. The
 *  open state is remembered per section in this browser. */
export function PanelSection({
  id,
  title,
  grow = false,
  children,
}: {
  id: string;
  title: ReactNode;
  /** Fill the remaining height (and scroll) while open. */
  grow?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => readOpen(id));

  function toggle() {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(STORAGE_KEY(id), next ? "1" : "0");
    } catch {
      /* storage unavailable: still toggles for this session */
    }
  }

  return (
    <div className={`panel-section${open && grow ? " panel-section-grow" : ""}${open ? "" : " collapsed"}`}>
      <button
        type="button"
        className="panel-title panel-toggle"
        aria-expanded={open}
        onClick={toggle}
      >
        <svg className="panel-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M3 2l4 3-4 3" fill="none" stroke="currentColor" strokeWidth="1.5"
            strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {title}
      </button>
      {open && children}
    </div>
  );
}
