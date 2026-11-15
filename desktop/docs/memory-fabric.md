# Nova Memory Fabric

Nova Memory Fabric is the local, provider-independent evidence layer introduced in v0.6.0. It connects retained Nova conversations and project notes to the context used by Codex, Claude Code, and local models. It does not share their credentials, native sessions, or private memory databases.

The shipped codec is deterministic and extractive: it selects source spans rather than asking a model to rewrite history. Its compact views are **lossy**. Exact recovery applies only to text that Nova actually retained. This release makes no frontier benchmark, universal semantic-losslessness, or whole-system compression-ratio claim.

## Implemented architecture

| Component | Behavior |
| --- | --- |
| Source ledger | Project scope, stable origin, role, provider, timestamps, revision reference, SHA-256, and explicit coverage/omissions |
| Storage | Nova-owned SQLite WAL database; Brotli-compressed sources plus an independent FTS5 index over retained raw text |
| Worker | SQLite, indexing, compression, capsules, and context compilation run outside the renderer in a dedicated worker thread |
| Capsule | Verbatim spans, UTF-16 source offsets, protected-value hints, omitted ranges, and explicit lossy status |
| Retrieval | Raw full-text search plus bounded recent/thread candidates; details omitted from a capsule remain independently searchable |
| Context packet | Query obligations, selected source spans, coverage, expansion/omission information, watermark, and content hash |
| Lifecycle | Idempotent capture, revisions, user corrections, retirement, forgetting, and origin tombstones |
| Inspector | Paged search and exact source reads, revisions/coverage, correction, forgetting, and run context summaries |
| Model tools | Per-run project-scoped `memory_search` and `memory_read`; no model-accessible mutation tools |

The retained source is canonical; its capsule and ranking are derived views. An assistant claim is evidence of what the assistant said, not proof of its truth. A completed run is not a verified result. A matching source hash establishes byte identity, not correctness.

## Ownership and privacy

The database is `workspace/memory-fabric/memory.sqlite` under Nova's application-data directory, alongside—not inside—its private Codex runtime. Memory workers consume Nova-owned copies. They do not scan OEM folders, open native provider databases, copy credentials, or enable background OEM synchronization.

SQLite writes are transactional. Exact-source reads decompress the retained payload and validate its length and SHA-256. The independent FTS index prevents capsule omissions from becoming the only route to raw evidence. Worker queues, heap, source sizes, and response pages are bounded. A timed-out mutation is reported as an uncertain commit outcome and is not blindly retried.

**This is not an encrypted vault.** Database metadata, FTS terms, and SQLite sidecars contain sensitive-readable information. Brotli is not encryption. Existing plugin credential encryption does not encrypt this memory store. Visible-text redaction is best effort; private information can remain.

## Capture and legacy coverage

The ledger distinguishes user text, assistant claims, notes, imported references, visible tool observations, corrections, and checkpoints. It captures supported visible evidence, not hidden reasoning, native provider state, or arbitrary attachments.

Every source carries `complete`, `bounded`, or `legacy` coverage and known omissions. Original character counts can be smaller than retained counts when a redaction placeholder is longer than the original secret. Existing Nova histories and OEM imports were already bounded; migration cannot reconstruct omitted text and never upgrades those histories into a complete archive.

Repeated origin/content capture is idempotent. A shorter legacy replay cannot replace a fuller retained source. Replaying historical content cannot reactivate a superseded record or undo a user correction. Repeated copies are not independent corroboration.

## Progressive context codec

`makeCapsule` selects exact wording and offsets, including useful numbers, identifiers, and qualifiers. `compileMemoryPacket` detects query obligations such as exact values, quotations, chronology, complete lists, constraints, and provenance. It combines relevant capsule spans with query-focused raw-source spans; an evidence-mode packet expands the source detail rather than inventing a reconstructed summary.

The serialized model-facing JSON has a hard character budget and includes source roles, hashes, coverage, spans, omissions, and warnings. Preview and launch share compilation. Run receipts identify the packet, its source revisions, and the compiled prompt hash. Memory remains reference data: it cannot grant permissions, override the current user request, or turn an earlier proposal into an accomplished event.

Retrieval remains bounded, and obligation/protected-value detection is heuristic. A complete-list question may require more pages; lexical search may miss paraphrases. Agents should recover missing evidence with the read tools when available or state the gap. The omission manifest is not proof that every future question is answerable.

| Current boundary | Limit |
| --- | --- |
| Individual source | 2 Mi UTF-16 characters and 8 MiB UTF-8 |
| Ingest batch | 64 sources and 16 MiB UTF-8 |
| Raw compilation candidates | 32 sources and 4 Mi UTF-16 characters |
| Default capsule | 1,600 characters of selected source spans |
| Workspace memory packet | 16,000 characters of serialized memory JSON |
| Inspector source page | Up to 64,000 characters |
| Model search/read | Up to 8 hits / 8,000 source characters per call |
| Per-run model expansion | 64 calls and 512 KiB emitted tool output |

Capture/redaction applies a tighter 4 MiB UTF-8 bound and records any omitted tail. The packet budget excludes separately reviewed manual notes, skills, tool instructions, and the current request. Token counts are estimates, not tokenizer measurements or billing guarantees. Compressed payload bytes exclude FTS, SQLite structures, metadata, receipts, and backups; they are not total storage savings.

## Notes, correction, and forgetting

Active manual notes retain the existing linked-file freshness and explicit-sharing rules. Both active and archived manual-note origins are excluded from automatic Fabric packing, preventing duplicate inclusion, freshness-check bypass, or stale-note replay during an interrupted archive. Explicit user-correction records are the exception: they remain eligible even under the same origin key. Archiving a note retires its Fabric source. Correcting or forgetting it through the Fabric inspector first removes the old active manual-note path; a correction becomes a new user-authored revision, not revalidation of its original file. Bootstrap retirement targets ordinary notes rather than retiring those explicit corrections.

With a Fabric packet present, the old automatic recent-run/imported-history injection is disabled. Otherwise a corrected or forgotten value could resurface through that separate legacy path. Conversation display remains separate from automatic memory context.

Correction preserves historical sources and invalidates dependent receipts. Retirement hides an active value without deleting history. Forgetting removes the origin's revisions, payloads, raw search entries, capsules, and dependent stored packets. A hashed origin tombstone prevents automatic reimport from restoring it.

Correcting, forgetting, or archiving a manual note disables Nova's direct shared-file injection for that project in the same workspace transaction, so an old `.nova/MEMORY.md` export cannot silently reintroduce the removed note through that path. The exported file itself is not rewritten. Preview and explicitly republish shared notes before re-enabling that integration; ordinary provider-side project-file access remains separate. Forgetting does **not** recall original conversations, already-sent provider requests, exported files, operating-system snapshots, or external backups. SQLite cleanup is not a forensic device-erasure guarantee. `.nova/MEMORY.md` remains an explicitly reviewed compatibility export, not the canonical ledger or a live mirror. Existing managed-block previews and publication confirmations remain intact.

## Read-only model capability

The authenticated loopback memory server fixes the project at run creation. Arguments cannot select another project. `memory_read` accepts only source IDs in the initial packet or disclosed by that run's searches. Inputs, outputs, calls, and pages are bounded; cancellation and shutdown revoke the run's capability.

The selected provider receives the returned evidence. A cloud run therefore shares those authorized project excerpts with that provider. The memory engine itself makes no extra cloud calls to summarize or embed the archive. Existing provider restrictions remain in force; unsupported memory tools must not silently weaken required safe-mode policy. The initial text packet remains the portable representation across supported backends.

## Code boundaries

- `src/shared/memory-fabric.ts`: source, coverage, packet, and paged API types.
- `src/main/services/memory-fabric/store.ts`: SQLite, compressed ledger, raw search, revisions, retirement, and deletion.
- `worker.ts` and `service.ts`: worker RPC, queue/timeout/cancellation boundaries, and lifecycle.
- `codec.ts`: extractive capsules, query obligations, raw-span recovery, and budgeted packets.
- `capture.ts`: Nova-owned migration and supported visible-event capture.
- `mcp.ts`: per-run authenticated read-only capability.
- Existing `context.ts` and `workspace-service.ts`: shared preview/launch path, run/note lifecycle, imports, and receipts.

The packaged worker is `dist/main/memory-worker.cjs`. Development uses the TypeScript worker with the repository's loader. Runtime Node/Electron SQLite support and packaged worker resolution are explicit requirements.

## Research basis and limits

Design inspiration—not inherited benchmark proof:

- [QEMem, October 2026](https://arxiv.org/html/2610.22668v1): relevant records are not automatically a sufficient evidence set; Nova uses explicit obligations and source recovery, not its entire model-driven pipeline.
- [TierMem, February 2026](https://arxiv.org/html/2602.17913v1): linked compact views can route toward raw evidence; Nova does not ship its trained router.
- [MEMOIR, November 2026](https://arxiv.org/html/2611.07631v1): preserve lineage and evaluate lifecycle changes; a judge's opinion is not a mathematical losslessness certificate.
- [ASTC](https://arxiv.org/html/2610.41291v1) and [LatComm](https://arxiv.org/html/2610.26840v1), October 2026: latent compression is a distinct model/backend research direction, not text that current hosted interfaces can simply consume.

This release does not implement dense embeddings, learned semantic extraction, a trained sufficiency router, a temporal knowledge graph, global personal-profile inference, automatic ChatGPT native-memory access, or trained latent/soft-token compression. Those remain explicit future capabilities.

Future evaluation must compare raw episodic retrieval, the same retrieval without compact packing, and the complete codec at matched budgets. Measure newly introduced errors, exact-value fidelity, grounding, fallback cost, correction/deletion behavior, and cross-provider continuation. Count ingestion, indexing, routing, raw recovery, and total storage separately from selected-context reduction. Small fixture tests cannot establish universal no-loss behavior.

## Release verification

Focused tests cover exact retained text, raw search outside capsules, project isolation, revisions/replay, retirement, forgetting, packet budgets, and tool scope. After integration, run typecheck, the focused integration checks, and a build; rerun only affected failing checks after a fix.

A Linux source build is not proof of Windows packaging, real-account compatibility, long-history responsiveness, or a fix for a reported Windows freeze. Windows artifact/worker execution and live-provider acceptance require their own recorded CI or real-machine results. Do not infer those results from source inspection or test constants.
