import { X, Terminal, Cpu, Bot } from "lucide-react";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { ProviderId, Run } from "../../shared/types";

export const providerNames: Record<ProviderId, string> = {
  codex: "Codex",
  claude: "Claude Code",
  ollama: "Local model",
};
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}
export function isActive(run: Run): boolean {
  return run.status === "queued" || run.status === "running";
}
export function statusLabel(run: Run): string {
  if (run.status === "completed") return "Finished · not verified";
  return {
    queued: "Queued",
    running: "Working",
    failed: "Failed",
    cancelled: "Stopped",
    interrupted: "Interrupted",
  }[run.status];
}

export function NovaMark() {
  return (
    <span className="nova-mark" aria-hidden="true">
      <svg viewBox="0 0 32 32" fill="none">
        <path
          d="M8 24V8l16 16V8"
          stroke="currentColor"
          strokeWidth="2.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
export function ProviderMark({
  provider,
  small = false,
}: {
  provider: ProviderId;
  small?: boolean;
}) {
  const Icon =
    provider === "ollama" ? Cpu : provider === "claude" ? Bot : Terminal;
  return (
    <span
      aria-hidden="true"
      className={`provider-mark ${small ? "small" : ""}`}
    >
      <Icon size={small ? 14 : 17} strokeWidth={1.6} />
    </span>
  );
}
export function EmptyPanel({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="empty-panel">
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
  className = "",
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    (
      dialog?.querySelector<HTMLElement>(
        "[data-autofocus], input, textarea, select",
      ) ?? dialog?.querySelector<HTMLElement>("button")
    )?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close.current();
      }
      if (event.key !== "Tab" || !dialog) return;
      const elements = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
        ),
      );
      const first = elements[0];
      const last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      previousFocus?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? "modal-wide" : ""} ${className}`}
      >
        <div className="modal-heading">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
