import type { FabricCoverage, FabricSourceInput } from "../../../shared/memory-fabric";
import type { MemoryEntry, Run, RunEvent, Thread, VerificationResult, WorkspaceState } from "../../../shared/types";
import { MemoryFabricService } from "./service";
import { MAX_SOURCE_BYTES, redactMemoryMetadata as metadata, redactMemoryText } from "./redaction";
export { redactMemoryText } from "./redaction";

const MAX_PENDING_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_JOBS = 64;
const BATCH_BYTES = 512 * 1024;
const METADATA_ALLOWANCE = 8_192;
const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

function source(
  input: Omit<FabricSourceInput, "coverage">,
  status: FabricCoverage["status"],
  omissions: string[] = [],
): FabricSourceInput {
  const retained = redactMemoryText(input.text);
  const allOmissions = [...omissions, ...retained.omissions];
  const title = metadata(input.title, 1_024) || "Retained visible evidence";
  const provider = metadata(input.provider, 120);
  const sourceRef = metadata(input.sourceRef, 4_096);
  const revision = metadata(input.revision, 1_024);
  const metadataChanged = title !== input.title || provider !== input.provider || sourceRef !== input.sourceRef || revision !== input.revision;
  if (metadataChanged) allOmissions.push("Source metadata was bounded or filtered for recognizable credentials before retention.");
  const observedAt = Number.isFinite(Date.parse(input.observedAt)) ? input.observedAt : new Date().toISOString();
  if (observedAt !== input.observedAt) allOmissions.push("Original observation time was unavailable; capture time was used.");
  return {
    ...input,
    title, provider, sourceRef, revision,
    observedAt,
    text: retained.text,
    coverage: {
      status: status === "legacy" ? "legacy" : allOmissions.length ? "bounded" : status,
      omissions: allOmissions.slice(0, 32),
      retainedCharacters: retained.text.length,
      originalCharacters: retained.originalCharacters,
      ...(retained.redacted || metadataChanged ? { redacted: true } : {}),
    },
  };
}

function noteSource(memory: MemoryEntry, legacy = false): FabricSourceInput {
  return source({
    key: `note:${memory.id}`, projectId: memory.projectId, kind: "note", title: memory.title,
    text: memory.content, observedAt: memory.updatedAt, sourceRef: memory.filePath || memory.source,
    revision: memory.commit,
  }, legacy ? "legacy" : "complete", [
    ...(legacy ? ["Migrated from the retained workspace note; earlier revisions may not have been retained."] : []),
    ...(memory.filePath ? ["The note references a project file; its fingerprint is not an archive of the referenced file's contents."] : []),
    ...(memory.codexSource ? ["This is an explicitly imported note copy, not a live native-memory database or complete provider history."] : []),
  ]);
}

function promptSource(run: Run, legacy = false): FabricSourceInput {
  return source({ key: `run:${run.id}:prompt`, projectId: run.projectId, threadId: run.threadId,
    runId: run.id, provider: run.provider, kind: "user", title: "User request", text: run.prompt,
    observedAt: run.createdAt, revision: run.baseCommit,
  }, legacy ? "legacy" : "complete", legacy ? ["Migrated from retained workspace history; material discarded before this migration is unavailable."] : []);
}

function eventSource(run: Run, event: Pick<RunEvent, "id" | "at" | "kind" | "text">, legacy = false): FabricSourceInput | undefined {
  if (event.kind !== "message" && event.kind !== "tool") return undefined;
  return source({ key: `run:${run.id}:event:${event.id}`, projectId: run.projectId, threadId: run.threadId,
    runId: run.id, provider: run.provider, kind: event.kind === "tool" ? "tool" : "assistant",
    title: event.kind === "tool" ? "Observed normalized tool event" : "Visible assistant message",
    text: event.text, observedAt: event.at, revision: run.baseCommit,
  }, legacy ? "legacy" : event.kind === "tool" ? "bounded" : "complete", [
    ...(legacy ? ["Legacy visible event may already have been truncated or normalized by the UI history path."] : []),
    ...(event.kind === "tool" ? ["Supported normalized tool event only; omitted tool arguments, results, or binary attachments are not recoverable here."] : []),
  ]);
}

function* importSources(thread: Thread, legacy = false): IterableIterator<FabricSourceInput> {
  if (!thread.codex) return;
  for (const message of thread.codex.history) yield source({
    key: `import:${thread.id}:${message.id}:${message.turnId}`, projectId: thread.projectId, threadId: thread.id,
    kind: "import", provider: "codex", title: `Imported ${message.role} message`,
    // Preserve speaker explicitly; import is evidence of an utterance, not independent verification.
    text: message.text, observedAt: thread.codex!.importedAt,
    sourceRef: `Imported visible ${message.role} message from conversation ${thread.codex!.sourceThreadId}`,
  }, legacy ? "legacy" : "bounded", [
    "Original message time was unavailable in the supported import projection; observation time is the import time.",
    "Only approved visible-text copies are retained, without native sessions, hidden reasoning, credentials, or binary attachments.",
    ...(thread.codex!.historyTruncated ? ["The imported conversation was already incomplete; earlier pages or long messages may be missing."] : []),
    ...(legacy ? ["Imported copy replayed from legacy workspace state."] : []),
  ]);
}

function outcomeSource(run: Run, legacy = false): FabricSourceInput {
  return source({ key: `run:${run.id}:outcome`, projectId: run.projectId, threadId: run.threadId, runId: run.id,
    provider: run.provider, kind: "checkpoint", title: "Run outcome and continuation checkpoint",
    observedAt: run.finishedAt || run.createdAt, revision: run.baseCommit,
    text: JSON.stringify({ status: run.status, model: run.model, mode: run.mode, branch: run.branch,
      baseCommit: run.baseCommit, terminationUnconfirmed: !!run.terminationUnconfirmed,
      error: run.error, verification: "A completed agent run does not establish that verification passed. Consult separately captured verification evidence.",
    }),
  }, legacy ? "legacy" : "complete", legacy ? ["Outcome replayed from retained workspace state."] : []);
}

function verificationSource(result: VerificationResult, legacy = false): FabricSourceInput {
  return source({ key: `verification:${result.id}`, projectId: result.projectId, threadId: result.threadId,
    runId: result.runId, kind: "tool", title: `Verification result: ${result.profileName}`,
    observedAt: result.finishedAt || result.createdAt,
    revision: result.outputRevision?.head || result.inputRevision?.head,
    text: JSON.stringify({ profile: result.profileName, status: result.status, executable: result.executable,
      args: result.args, exitCode: result.exitCode, inputRevision: result.inputRevision, outputRevision: result.outputRevision,
      terminationUnconfirmed: !!result.terminationUnconfirmed, output: result.output, error: result.error,
      scope: "This observation applies to the recorded revision and command, not arbitrary later files or all possible behavior.",
    }),
  }, legacy ? "legacy" : result.truncated ? "bounded" : "complete", [
    ...(result.truncated ? ["Verification output was already truncated before memory capture."] : []),
    ...(legacy ? ["Verification replayed from retained workspace state."] : []),
  ]);
}

interface CaptureJob { inputs: FabricSourceInput[]; bytes: number }
const inputBytes = (input: FabricSourceInput) => Buffer.byteLength(input.text, "utf8")
  + Buffer.byteLength(JSON.stringify({ ...input, text: undefined }), "utf8");

/** Captures only Nova-owned visible evidence. It never opens OEM files or calls a model. */
export class WorkspaceMemory {
  private memoryService?: MemoryFabricService;
  migrationPending = false;
  captureWarning?: string;
  private initialized = false;
  private closing = false;
  private failure?: Error;
  private ingestionBlocked = false;
  private pendingBytes = 0;
  private readonly jobs: CaptureJob[] = [];
  private migrationTask?: Promise<void>;
  private drainTask?: Promise<void>;
  private disposeTask?: Promise<void>;

  constructor(private readonly dataDir: string, service?: MemoryFabricService) {
    // WorkspaceService must validate Nova ownership before initialize starts a worker.
    this.memoryService = service;
  }

  get service(): MemoryFabricService {
    if (!this.memoryService) throw new Error("Nova memory has not been initialized in an owned data directory.");
    return this.memoryService;
  }

  private failed(error: unknown, blockIngestion = true): void {
    this.ingestionBlocked ||= blockIngestion;
    this.failure ??= error instanceof Error ? error : new Error("Nova memory capture failed.");
    this.captureWarning = `Memory capture is incomplete: ${this.failure.message} Existing committed evidence is preserved. Restart and inspect retained source coverage before relying on memory.`;
  }

  private async ingest(inputs: Iterable<FabricSourceInput>): Promise<void> {
    let batch: FabricSourceInput[] = [];
    let bytes = 0;
    for (const input of inputs) {
      const size = inputBytes(input);
      if (batch.length && (batch.length >= 16 || bytes + size > BATCH_BYTES)) {
        await this.service.ingest(batch); batch = []; bytes = 0; await yieldTurn();
      }
      batch.push(input); bytes += size;
    }
    if (batch.length) await this.service.ingest(batch);
  }

  initialize(state: WorkspaceState): void {
    if (this.initialized) return;
    if (this.closing) throw new Error("Nova memory is already shutting down.");
    this.initialized = true;
    this.memoryService ??= new MemoryFabricService(this.dataDir);
    this.migrationPending = true;
    // References to already-retained strings do not clone the large workspace payload.
    const notes = state.memories.slice();
    const imports = state.threads.filter((thread) => !!thread.codex);
    const runs = state.runs.map((run) => ({ run, eventCount: run.events.length }));
    const verifications = state.verifications.slice();
    this.migrationTask = (async () => {
      await yieldTurn();
      try {
        for (const note of notes) {
          if (note.status === "active") await this.ingest([noteSource(note, true)]);
          else await this.service.retire({ projectId: note.projectId, key: `note:${note.id}`, notesOnly: true });
          await yieldTurn();
        }
        for (const thread of imports) { await this.ingest(importSources(thread, true)); await yieldTurn(); }
        for (const { run, eventCount } of runs) {
          await this.ingest([promptSource(run, true)]);
          function* retainedEvents(): IterableIterator<FabricSourceInput> {
            for (let offset = 0; offset < eventCount; offset++) {
              const event = run.events[offset];
              if (!event) continue;
              const input = eventSource(run, event, true);
              if (input) yield input;
            }
          }
          await this.ingest(retainedEvents());
          if (!["queued", "running"].includes(run.status)) await this.ingest([outcomeSource(run, true)]);
          await yieldTurn();
        }
        for (const result of verifications) { await this.ingest([verificationSource(result, true)]); await yieldTurn(); }
      } catch (error) { this.failed(error); }
      finally { this.migrationPending = false; this.startDrain(); }
    })();
  }

  private enqueue(inputs: Iterable<FabricSourceInput>): void {
    if (this.closing) { this.failed(new Error("An event arrived after memory shutdown began; it was not captured."), false); return; }
    if (this.ingestionBlocked) return;
    if (!this.initialized) { this.failed(new Error("A visible source arrived before Nova memory initialization.")); return; }
    const migrationReserve = this.migrationPending ? MAX_SOURCE_BYTES + BATCH_BYTES + METADATA_ALLOWANCE : 0;
    const retained: FabricSourceInput[] = [];
    let bytes = 0;
    for (const input of inputs) {
      bytes += inputBytes(input);
      if (this.jobs.length >= MAX_PENDING_JOBS || this.pendingBytes + bytes + migrationReserve > MAX_PENDING_BYTES) break;
      retained.push(input);
    }
    if (this.jobs.length >= MAX_PENDING_JOBS || this.pendingBytes + bytes + migrationReserve > MAX_PENDING_BYTES) {
      this.failed(new Error("The bounded memory capture queue overflowed; at least one visible source was not retained by Memory Fabric."), false);
      return;
    }
    if (!retained.length) return;
    this.jobs.push({ inputs: retained, bytes }); this.pendingBytes += bytes;
    this.startDrain();
  }

  private startDrain(): void {
    if (this.drainTask || this.migrationPending || this.ingestionBlocked) return;
    this.drainTask = (async () => {
      while (this.jobs.length && !this.ingestionBlocked) {
        const job = this.jobs[0];
        try { await this.ingest(job.inputs); }
        catch (error) { this.failed(error); break; }
        this.jobs.shift(); this.pendingBytes -= job.bytes;
        await yieldTurn();
      }
    })().finally(() => { this.drainTask = undefined; });
  }

  captureNote(memory: MemoryEntry): void { if (memory.status === "active") this.enqueue([noteSource(memory)]); }
  captureImport(thread: Thread): void { this.enqueue(importSources(thread)); }
  captureRunPrompt(run: Run): void { this.enqueue([promptSource(run)]); }
  captureEvent(run: Run, event: Pick<RunEvent, "id" | "at" | "kind" | "text">): void {
    const input = eventSource(run, event); if (input) this.enqueue([input]);
  }
  captureOutcome(run: Run): void { this.enqueue([outcomeSource(run)]); }
  captureVerification(result: VerificationResult): void { this.enqueue([verificationSource(result)]); }

  async idle(): Promise<void> {
    await this.migrationTask;
    while (!this.ingestionBlocked && (this.drainTask || this.jobs.length)) {
      this.startDrain(); await this.drainTask;
    }
    if (this.failure) throw new Error(this.captureWarning, { cause: this.failure });
  }

  dispose(): Promise<void> {
    if (this.disposeTask) return this.disposeTask;
    this.closing = true;
    this.disposeTask = (async () => {
      try { await this.idle(); }
      finally { await this.memoryService?.dispose(); }
    })();
    return this.disposeTask;
  }
}
