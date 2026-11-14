import { Archive, ArchiveRestore, Download, Pin, PinOff, Pencil, RefreshCw } from "lucide-react";
import { useEffect, useRef } from "react";
import type { Thread } from "../../shared/types";

export function ThreadMenu({
  thread,
  anchor,
  onClose,
  onRename,
  onPin,
  onArchive,
  onExport,
  exporting,
  onRefreshCodex,
  sharing,
}: {
  thread: Thread;
  anchor: { x: number; y: number };
  onClose: () => void;
  onRename: () => void;
  onPin: () => void;
  onArchive: () => void;
  onExport: () => void;
  exporting: boolean;
  onRefreshCodex: () => void;
  sharing: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const buttons = Array.from(
          ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
        );
        const index = buttons.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const next =
          (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
          buttons.length;
        buttons[next]?.focus();
      }
    };
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", outside);
      previous?.focus();
    };
  }, []);
  return (
    <div
      ref={ref}
      className="thread-menu-popover"
      role="menu"
      aria-label={`Actions for ${thread.title}`}
      style={{
        left: Math.min(anchor.x, window.innerWidth - 218),
        top: Math.max(8, Math.min(anchor.y, window.innerHeight - (thread.codex ? 265 : 230))),
      }}
    >
      <button role="menuitem" onClick={onRename}>
        <Pencil size={14} />
        Rename
      </button>
      <button role="menuitem" onClick={onPin}>
        {thread.pinned ? <PinOff size={14} /> : <Pin size={14} />}
        {thread.pinned ? "Unpin thread" : "Pin thread"}
      </button>
      <button role="menuitem" onClick={onArchive}>
        {thread.archivedAt ? (
          <ArchiveRestore size={14} />
        ) : (
          <Archive size={14} />
        )}
        {thread.archivedAt ? "Restore thread" : "Archive thread"}
      </button>
      <button role="menuitem" onClick={onExport} disabled={exporting}>
        <Download size={14} />
        Export as Markdown…
      </button>
      {thread.codex && <button role="menuitem" onClick={onRefreshCodex} disabled={sharing}>
        <RefreshCw size={14} />Copy latest from Codex
      </button>}
    </div>
  );
}
