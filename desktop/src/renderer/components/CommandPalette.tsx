import { Folder, MessageSquare, Plus, Search, Settings2 } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Project, Thread } from "../../shared/types";
import { Modal } from "./primitives";

export function CommandPalette({
  projects,
  threads,
  canCreateThread,
  onProject,
  onThread,
  onNewThread,
  onOpenProject,
  onSettings,
  onClose,
}: {
  projects: Project[];
  threads: Thread[];
  canCreateThread: boolean;
  onProject: (id: string) => void;
  onThread: (thread: Thread) => void;
  onNewThread: () => void;
  onOpenProject: () => void;
  onSettings: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const activeOption = useRef<HTMLButtonElement>(null);
  const commands = useMemo(
    () =>
      [
        ...(canCreateThread
          ? [
              {
                id: "new",
                label: "New thread",
                detail: "Current project",
                icon: Plus,
                action: onNewThread,
              },
            ]
          : []),
        {
          id: "open",
          label: "Open project",
          detail: "Choose a Git repository",
          icon: Folder,
          action: onOpenProject,
        },
        {
          id: "settings",
          label: "Settings",
          detail: "Agents and appearance",
          icon: Settings2,
          action: onSettings,
        },
        ...projects.map((project) => ({
          id: `project-${project.id}`,
          label: project.name,
          detail: "Project",
          icon: Folder,
          action: () => onProject(project.id),
        })),
        ...threads
          .filter((thread) => !thread.archivedAt)
          .map((thread) => ({
            id: `thread-${thread.id}`,
            label: thread.title,
            detail:
              projects.find((project) => project.id === thread.projectId)
                ?.name ?? "Thread",
            icon: MessageSquare,
            action: () => onThread(thread),
          })),
      ]
        .filter((command) =>
          `${command.label} ${command.detail}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        )
        .slice(0, 40),
    [
      projects,
      threads,
      query,
      canCreateThread,
      onNewThread,
      onOpenProject,
      onSettings,
      onProject,
      onThread,
    ],
  );
  const active = Math.min(selected, Math.max(commands.length - 1, 0));
  const activeId = commands[active]?.id;
  useLayoutEffect(() => {
    // Keep the combobox focused while revealing keyboard selection in long lists.
    activeOption.current?.scrollIntoView({ block: "nearest" });
  }, [activeId, query]);
  const choose = (index: number) => {
    const command = commands[index];
    if (!command) return;
    onClose();
    command.action();
  };
  return (
    <Modal
      title="Command palette"
      onClose={onClose}
      className="command-palette"
    >
      <div className="command-search">
        <Search size={17} />
        <input
          data-autofocus="true"
          aria-label="Search commands"
          role="combobox"
          aria-expanded="true"
          aria-controls="command-results"
          aria-autocomplete="list"
          aria-activedescendant={
            commands[active] ? `command-${commands[active].id}` : undefined
          }
          placeholder="Search projects, threads, and actions…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setSelected((active + 1) % Math.max(commands.length, 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setSelected(
                (active - 1 + commands.length) % Math.max(commands.length, 1),
              );
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(active);
            }
          }}
        />
      </div>
      <div
        className="command-results"
        id="command-results"
        role="listbox"
        aria-label="Commands"
      >
        {commands.map((command, index) => (
          <button
            ref={active === index ? activeOption : undefined}
            type="button"
            role="option"
            aria-selected={active === index}
            className={active === index ? "selected" : ""}
            key={command.id}
            id={`command-${command.id}`}
            onClick={() => choose(index)}
            onMouseMove={() => setSelected(index)}
          >
            <command.icon size={16} />
            <span>{command.label}</span>
            <small>{command.detail}</small>
          </button>
        ))}
        {commands.length === 0 && (
          <p className="empty-command">
            No matching commands or conversations.
          </p>
        )}
      </div>
      <div className="palette-help">
        <span>Arrow keys to navigate</span>
        <span>Enter to open · Esc to close</span>
      </div>
    </Modal>
  );
}
