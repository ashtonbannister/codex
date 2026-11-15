import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  FabricCorrectionRequest, FabricForgetRequest, FabricForgetResult,
  FabricPacket, FabricPacketReceipt, FabricPrepareRequest, FabricReadRequest,
  FabricReadResult, FabricSearchQuery, FabricSearchResult, FabricSource,
  FabricSourceInput, FabricStats,
} from "../../../shared/memory-fabric";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup?: () => void;
};

/** Main-process facade. SQLite, raw text indexing and compression never run here. */
export class MemoryFabricService {
  private readonly worker: Worker;
  private readonly ready: Promise<void>;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closing = false;
  private startingRequests = 0;
  private failure?: Error;
  private disposePromise?: Promise<void>;

  constructor(dataDir: string, options: { workerPath?: string | URL } = {}) {
    // Production is bundled to dist/main; source execution is useful for focused tests.
    const moduleUrl = import.meta.url;
    const workerPath = options.workerPath ?? (moduleUrl
      ? fileURLToPath(new URL("./worker.ts", moduleUrl))
      : path.resolve(__dirname, "memory-worker.cjs"));
    const isSourceWorker = (workerPath instanceof URL ? workerPath.pathname : workerPath).endsWith(".ts");
    // Test runners/Electron may expand execArgv with process-only flags that
    // Worker rejects. Source workers need only their explicit loader; packaged
    // CJS workers need no inherited debugger, test, snapshot, or runtime flags.
    const execArgv = isSourceWorker
      ? ["--import", pathToFileURL(createRequire(moduleUrl || path.join(__dirname, "main.cjs")).resolve("tsx")).href]
      : [];
    this.worker = new Worker(workerPath, { workerData: { dataDir }, resourceLimits: { maxOldGenerationSizeMb: 256 },
      execArgv });
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error("Nova memory startup timed out. Existing evidence was preserved.");
        reject(error); this.fail(error); void this.worker.terminate();
      }, 15_000);
      timer.unref();
      this.worker.on("message", (message: { ready?: boolean; startupError?: string; id?: number; result?: unknown; error?: string }) => {
        if (message.ready) {
          clearTimeout(timer); resolve();
          if (!this.pending.size && !this.startingRequests) this.worker.unref();
          return;
        }
        if (message.startupError) {
          clearTimeout(timer);
          const error = new Error(message.startupError);
          reject(error); this.fail(error); return;
        }
        if (message.id === undefined) return;
        const item = this.pending.get(message.id);
        if (!item) return;
        this.pending.delete(message.id);
        clearTimeout(item.timer); item.cleanup?.();
        if (message.error) item.reject(new Error(message.error));
        else item.resolve(message.result);
        if (!this.pending.size && !this.startingRequests) this.worker.unref();
      });
      this.worker.on("error", (error) => { clearTimeout(timer); reject(error); this.fail(error); });
      this.worker.on("exit", (code) => {
        clearTimeout(timer);
        if (!this.closing || this.pending.size) {
          const error = new Error(`Nova memory worker stopped (${code}). Committed evidence is preserved; restart Nova before continuing memory operations.`);
          reject(error); this.fail(error);
        }
      });
    });
    // An unused service must not produce an unhandled promise rejection on startup failure.
    void this.ready.catch(() => undefined);
  }

  private fail(error: Error): void {
    this.failure = error;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer); item.cleanup?.(); item.reject(error);
    }
    this.pending.clear();
    this.worker.unref();
  }

  private async request<T>(method: string, input: unknown, signal?: AbortSignal): Promise<T> {
    if (this.failure) throw this.failure;
    if (this.closing && method !== "close") throw new Error("Nova memory is shutting down.");
    if (signal?.aborted) throw new Error("Memory operation cancelled.");
    if (method !== "close" && this.pending.size + this.startingRequests >= 64)
      throw new Error("Nova memory is busy. Retry after the current bounded queue has drained.");
    this.startingRequests++;
    this.worker.ref();
    try { await this.ready; }
    finally { this.startingRequests--; }
    if (this.failure) throw this.failure;
    if (this.closing && method !== "close") throw new Error("Nova memory is shutting down.");
    if (signal?.aborted) throw new Error("Memory operation cancelled.");
    if (this.pending.size >= 64) throw new Error("Nova memory is busy. Retry after the current bounded queue has drained.");
    const requestId = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Never retry a timed-out write blindly: it may have committed before the response was lost.
        const error = new Error("Nova memory operation timed out; its commit outcome is unknown. Restart Nova and inspect the source before retrying a mutation.");
        this.fail(error); void this.worker.terminate();
      }, 30_000);
      timer.unref();
      const item: Pending = { resolve: (value) => resolve(value as T), reject, timer };
      if (signal) {
        const abort = () => {
          clearTimeout(timer); item.cleanup?.(); this.pending.delete(requestId);
          reject(new Error("Memory operation cancelled. Already committed evidence is retained."));
          if (!this.pending.size) this.worker.unref();
        };
        signal.addEventListener("abort", abort, { once: true });
        item.cleanup = () => signal.removeEventListener("abort", abort);
      }
      this.pending.set(requestId, item);
      this.worker.ref();
      try { this.worker.postMessage({ id: requestId, method, input }); }
      catch (error) {
        clearTimeout(timer); item.cleanup?.(); this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error("Memory request could not be sent."));
        if (!this.pending.size) this.worker.unref();
      }
    });
  }

  ingest(input: FabricSourceInput[]): Promise<FabricSource[]> { return this.request("ingest", input); }
  search(input: FabricSearchQuery, signal?: AbortSignal): Promise<FabricSearchResult> { return this.request("search", input, signal); }
  read(input: FabricReadRequest, signal?: AbortSignal): Promise<FabricReadResult> { return this.request("read", input, signal); }
  correct(input: FabricCorrectionRequest): Promise<FabricSource> { return this.request("correct", input); }
  retire(input: { projectId: string; key: string; notesOnly?: boolean }): Promise<void> { return this.request("retire", input); }
  forget(input: FabricForgetRequest): Promise<FabricForgetResult> { return this.request("forget", input); }
  stats(projectId: string): Promise<FabricStats> { return this.request("stats", projectId); }
  prepare(input: FabricPrepareRequest, signal?: AbortSignal): Promise<FabricPacket> { return this.request("prepare", input, signal); }
  recordPacket(input: FabricPacketReceipt): Promise<void> { return this.request("recordPacket", input); }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.closing = true;
    this.disposePromise = (async () => {
      try { if (!this.failure) await this.request("close", undefined); }
      finally { await this.worker.terminate(); }
    })();
    return this.disposePromise;
  }
}
