import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";
import type {
  MemoryEntry,
  MemoryInput,
  MemoryKind,
  Thread,
  VerificationProfile,
  VerificationProfileInput,
} from "../../shared/types";
import { api, isPreview } from "../bridge";
import { errorText, Modal } from "./primitives";

export { SettingsForm } from "./SettingsForm";

export function MemoryForm({
  projectId,
  entry,
  onClose,
}: {
  projectId: string;
  entry?: MemoryEntry;
  onClose: () => void;
}) {
  const [values, setValues] = useState<MemoryInput>({
    id: entry?.id,
    projectId,
    title: entry?.title ?? "",
    content: entry?.content ?? "",
    kind: entry?.kind ?? "decision",
    source: entry?.source ?? "User-provided project knowledge",
    filePath: entry?.filePath ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api.saveMemory({
        ...values,
        filePath: values.filePath?.trim() || undefined,
      });
      onClose();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      title={entry ? "Edit project memory" : "Add project memory"}
      subtitle="Shared, source-linked knowledge for this project."
      onClose={onClose}
    >
      <form onSubmit={save}>
        {entry?.codexSource && (
          <p className="source-conversion-note">
            Saving this edit removes the Codex resource link and creates a
            manually maintained note. To keep the external fingerprint, cancel
            and preview/re-import the resource from Codex library instead.
          </p>
        )}
        <label className="field">
          <span>Title</span>
          <input
            maxLength={160}
            required
            value={values.title}
            onChange={(event) =>
              setValues({ ...values, title: event.target.value })
            }
            placeholder="e.g. Keep physics deterministic"
          />
        </label>
        <label className="field">
          <span>Type</span>
          <select
            value={values.kind}
            onChange={(event) =>
              setValues({ ...values, kind: event.target.value as MemoryKind })
            }
          >
            <option value="decision">Decision</option>
            <option value="constraint">Constraint</option>
            <option value="note">Note</option>
          </select>
        </label>
        <label className="field">
          <span>What should the agents know?</span>
          <textarea
            required
            rows={5}
            maxLength={8000}
            value={values.content}
            onChange={(event) =>
              setValues({ ...values, content: event.target.value })
            }
            placeholder="Include the reason or evidence when you can."
          />
        </label>
        <label className="field">
          <span>Source or reference</span>
          <input
            required
            maxLength={500}
            value={values.source}
            onChange={(event) =>
              setValues({ ...values, source: event.target.value })
            }
            placeholder="Document, test result, or your decision"
          />
        </label>
        <label className="field">
          <span>
            Linked source file <small>optional</small>
          </span>
          <input
            aria-label="Linked source file"
            maxLength={1000}
            value={values.filePath}
            onChange={(event) =>
              setValues({ ...values, filePath: event.target.value })
            }
            placeholder="Project-relative path, e.g. src/physics.ts"
          />
          <small>
            Review the original project source before saving. Saving
            fingerprints that checkout, not the selected thread’s worktree. A
            file existing only in the worktree cannot be linked here. This
            records source bytes, not factual truth.
          </small>
        </label>
        <p className="field-hint">
          Do not store credentials or secrets.
          {isPreview && " Preview entries stay in memory; no files are read."}
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" type="submit" disabled={saving}>
            {saving && <LoaderCircle size={15} className="spin" />}
            {entry?.codexSource ? "Save as manual memory" : "Save memory"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function RenameThreadForm({
  thread,
  onClose,
}: {
  thread: Thread;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(thread.title);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await api.updateThread({ id: thread.id, title: title.trim() });
      onClose();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal title="Rename thread" onClose={onClose}>
      <form onSubmit={save}>
        <label className="field">
          <span>Thread name</span>
          <input
            required
            maxLength={160}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary-button"
            disabled={saving || !title.trim()}
          >
            Save name
          </button>
        </div>
      </form>
    </Modal>
  );
}

const presets = [
  { name: "Typecheck", executable: "npm", args: ["run", "typecheck"] },
  { name: "Tests", executable: "npm", args: ["test"] },
  { name: "Build", executable: "npm", args: ["run", "build"] },
];

export function ProfileEditor({
  projectId,
  entry,
  onClose,
  onSaved,
}: {
  projectId: string;
  entry?: VerificationProfile;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(entry?.name ?? "");
  const [executable, setExecutable] = useState(entry?.executable ?? "npm");
  const [args, setArgs] = useState(
    JSON.stringify(entry?.args ?? ["test"], null, 2),
  );
  const [timeout, setTimeoutMinutes] = useState(entry?.timeoutMinutes ?? 10);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      const parsed: unknown = JSON.parse(args);
      if (
        !Array.isArray(parsed) ||
        !parsed.every((arg) => typeof arg === "string")
      )
        throw new Error(
          'Arguments must be a JSON array of strings, for example ["run", "test"].',
        );
      setSaving(true);
      const values: VerificationProfileInput = {
        id: entry?.id,
        projectId,
        name: name.trim(),
        executable: executable.trim(),
        args: parsed,
        timeoutMinutes: timeout,
      };
      await api.saveVerificationProfile(values);
      onSaved();
      onClose();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      className="profile-editor"
      onSubmit={save}
      aria-label={entry ? "Edit check profile" : "New check profile"}
    >
      <h3>{entry ? "Edit check profile" : "New check profile"}</h3>
      {!entry && (
        <div className="preset-row">
          <span>Fill from:</span>
          {presets.map((preset) => (
            <button
              key={preset.name}
              type="button"
              className="text-button"
              onClick={() => {
                setName(preset.name);
                setExecutable(preset.executable);
                setArgs(JSON.stringify(preset.args, null, 2));
              }}
            >
              {preset.name}
            </button>
          ))}
        </div>
      )}
      <label className="field">
        <span>Check name</span>
        <input
          required
          maxLength={120}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Typecheck"
        />
      </label>
      <label className="field">
        <span>Executable</span>
        <input
          required
          maxLength={1000}
          value={executable}
          onChange={(event) => setExecutable(event.target.value)}
          placeholder="npm or an executable path"
        />
      </label>
      <label className="field">
        <span>Arguments · JSON array</span>
        <textarea
          required
          rows={3}
          className="monospace"
          value={args}
          maxLength={8000}
          onChange={(event) => setArgs(event.target.value)}
          spellCheck={false}
        />
      </label>
      <label className="field">
        <span>Check timeout · minutes</span>
        <input
          type="number"
          min={1}
          max={120}
          required
          value={timeout}
          onChange={(event) => setTimeoutMinutes(Number(event.target.value))}
        />
      </label>
      <p className="field-hint">
        Saving does not run a command. Each check runs only after you request it
        and approve the native confirmation. Commands can write files; use
        trusted tools.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="inline-actions">
        <button type="button" className="secondary-button" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="primary-button" disabled={saving}>
          {saving && <LoaderCircle size={13} className="spin" />}Save profile
        </button>
      </div>
    </form>
  );
}
