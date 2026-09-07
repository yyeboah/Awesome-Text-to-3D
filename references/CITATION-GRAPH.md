# Citation graph

[Graph data](./citation-graph.json) stores indexed papers as nodes and directed citation links as edges. `source → target` means the source paper cites the target paper. Each node's `citationCount` is the number of distinct incoming source IDs. Duplicate rows, repeated references and self-citations do not increase the count.

The graph currently feeds the README counts, arrow hover previews and [full citing-paper lists](./internal-citations.md). It is a data graph, suitable for a future interactive viewer.

## Adding papers

Add the README and BibTeX entries in the usual style, then run from the repository root with Node.js 22 or newer:

```sh
node scripts/update-index-metadata.mjs
```

The updater reuses the persistent [citation cache](./citation-cache.json). For new papers it resolves metadata and references, then fetches all pages of incoming citations. Only relationships between indexed papers appear in the graph. References to papers outside the index remain in the cache, so they can become graph edges when those papers are added later. Unresolved papers retain `unavailable` counts and are retried on subsequent online runs.

Commit the README and BibTeX changes together with the generated citation cache, graph, and JSON/Markdown reports. The cache belongs in version control; it no longer depends on temporary storage.

## Rebuilding and refreshing

Rebuild from the saved data with no network requests:

```sh
node scripts/update-index-metadata.mjs --offline
```

An offline cache miss stops the update instead of inventing a zero count.

Refresh all indexed papers from Semantic Scholar, including their incoming citations:

```sh
node scripts/update-index-metadata.mjs --refresh
```

Run a full refresh periodically to catch delayed indexing and revised references. It is manual, can take longer, and follows API retry/backoff rules. Counts reflect available Semantic Scholar records and may omit citations not yet indexed. Each cached paper records `fetchedAt`; incoming lookups also record `citationsFetchedAt`. Graph `generatedAt` indicates the rebuild time, not the age of every source record.

## Files

- `citation-graph.json`: stable Semantic Scholar IDs, metadata, counts and directed edges between indexed works.
- `citation-cache.json`: deduplicated source records, complete reference IDs, incoming citation snapshots when fetched, and lookup aliases.
- `internal-citations.json`: per-README-entry counts, citing titles and `citedByIds` for unambiguous identity.
- `internal-citations.md`: full human-readable lists linked from README arrows.

Run the graph and incremental-update checks with:

```sh
node --test tests/citation-graph.test.mjs
```
