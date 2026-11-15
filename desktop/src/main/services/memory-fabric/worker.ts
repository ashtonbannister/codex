import { parentPort, workerData } from "node:worker_threads";
import type {
  FabricCorrectionRequest, FabricForgetRequest, FabricPacketReceipt,
  FabricPrepareRequest, FabricReadRequest, FabricSearchQuery, FabricSourceInput,
} from "../../../shared/memory-fabric";
import { compileMemoryPacket } from "./codec";
import { MemoryFabricStore } from "./store";

const port = parentPort;
if (!port) throw new Error("Nova's memory worker must run in its own worker thread.");

async function main(): Promise<void> {
  const store = await MemoryFabricStore.open(workerData.dataDir);
  let closed = false;
  port!.on("message", (message: { id: number; method: string; input: unknown }) => {
    if (!message || !Number.isSafeInteger(message.id) || message.id < 1 || closed) return;
    try {
      let result: unknown;
      switch (message.method) {
        case "ingest": result = store.ingest(message.input as FabricSourceInput[]); break;
        case "search": result = store.search(message.input as FabricSearchQuery); break;
        case "read": result = store.read(message.input as FabricReadRequest); break;
        case "correct": result = store.correct(message.input as FabricCorrectionRequest); break;
        case "retire": result = store.retire(message.input as { projectId: string; key: string; notesOnly?: boolean }); break;
        case "forget": result = store.forget(message.input as FabricForgetRequest); break;
        case "stats": result = store.stats(message.input as string); break;
        case "prepare": {
          const request = message.input as FabricPrepareRequest;
          const { candidates, watermark, warnings } = store.candidates(request);
          result = compileMemoryPacket(request, candidates, watermark, warnings);
          break;
        }
        case "recordPacket": result = store.recordPacket(message.input as FabricPacketReceipt); break;
        case "close": closed = true; store.close(); break;
        default: throw new Error("Unsupported Nova memory operation.");
      }
      port!.postMessage({ id: message.id, result });
      if (closed) port!.close();
    } catch (error) {
      port!.postMessage({ id: message.id, error: error instanceof Error ? error.message : "Nova memory operation failed." });
    }
  });
  port!.postMessage({ ready: true });
}

void main().catch((error) => {
  port.postMessage({ startupError: error instanceof Error ? error.message : "Nova memory could not start." });
  port.close();
});
