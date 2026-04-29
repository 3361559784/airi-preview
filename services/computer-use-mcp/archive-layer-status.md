# Archive Layer Status

Current archive status for the coding context/memory line.

This document is narrower than `context-memory-engineering.md` and should be
read together with `coding-context-memory-substrate-audit.md`.

## Current Confirmed State

Archive is no longer just a write-path prototype.

Current code includes:

- `src/archived-context/candidates.ts`
  - builds archive candidates from transcript blocks removed by projection
  - shares the same static retention limits as transcript projection
- `src/archived-context/serializer.ts`
  - serializes archive artifacts as markdown with frontmatter
- `src/archived-context/store.ts`
  - writes current-run artifacts under `archived-context/run/{run_id}`
  - rebuilds dedup state during `init()`
  - supports current-run substring `search()`
  - supports `readArtifact()` by artifact id returned from search
- `src/coding-runner/transcript-runtime.ts`
  - initializes `ArchiveContextStore`
  - writes `archiveCandidates` after each coding-turn projection
- `src/coding-runner/tool-runtime.ts`
  - exposes `coding_search_archived_context`
  - exposes `coding_read_archived_context`

The old blockers recorded here have been addressed in the current branch:

- archive projection tests are typecheck-clean
- `maxCompactedBlocks = 0` no longer classifies the same blocks as both
  compacted and dropped
- current archive tests cover the zero-compaction edge

## Correct Label

Archive is:

- current-run recallable archive
- deterministic filesystem storage
- bounded by artifact ids and simple substring search
- useful for recovering context displaced by projection pressure

Archive is not:

- cross-run long-term memory
- workspace memory
- vector search
- automatic prompt replay
- automatic promotion source
- a completed context governor

## Current Gaps

- Search is only current-run substring matching.
- Search does not yet rank by tags, files, task id, or confidence.
- Recalled archive content is labeled as historical evidence, but future prompt
  insertion paths must preserve that trust boundary.
- Archive and transcript projection share the same retention policy path in the
  runner, but the archive remains a coarse current-run substring recall surface.

## Next Archive-Specific Move

Archive Context is closed for the current memory baseline.

Do not add another archive-specific slice unless a repeated live failure maps
directly to current-run recall quality, search noise, or archive-denial
finalization.

Non-goals:

- no cross-run retrieval
- no vector index
- no automatic prompt replay
- no workspace memory promotion
- no GUI
