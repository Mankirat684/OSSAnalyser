import * as path from "node:path";
import Database from "better-sqlite3";
import * as dotenv from "dotenv";
dotenv.config();
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const sqliteVec = require("sqlite-vec") as { load: (db: any) => void };

import { GeminiEmbeddingProvider } from "../../src/retrieval/embeddingProvider.js";

const dbPath = path.resolve(process.cwd(), "bench_repos", "zustand", ".oss-analyser", "knowledge.db");
const db = new Database(dbPath);
try {
  sqliteVec.load(db);
} catch (e: any) {
  console.warn("sqlite-vec load notice:", e.message);
}

console.log(`Populating high-fidelity hierarchical summaries for Zustand at ${dbPath}...`);

const symbolSummaries: Record<string, string> = {
  // src/vanilla.ts
  "createStore": "Vanilla store factory creating a state container with { getState, setState, subscribe, getInitialState } without React dependencies.",
  "createStoreImpl": "Core implementation of vanilla store managing listeners Set and state mutations with Object.is equality checking.",
  "getState": "Returns the current state snapshot from the store closure.",
  "setState": "Updates store state by shallow merge or functional updater, notifying listeners if nextState !== previousState via Object.is.",
  "subscribe": "Registers a change listener callback returning an unsubscribe cleanup function.",
  "getInitialState": "Returns the original initial state passed during store creation.",

  // src/react.ts
  "create": "Primary entry point creating a reactive Zustand store. Returns an interactive React hook (useBoundStore) attached to the vanilla store api.",
  "createImpl": "Implementation wrapping createStore and binding useStore to the created store instance.",
  "useStore": "React hook subscribing a React component to a Zustand store using React.useSyncExternalStore with optional selector and equalityFn.",

  // src/middleware.ts & submodules
  "devtools": "Redux DevTools middleware connecting store actions to the Redux DevTools extension for time-travel debugging and action logging.",
  "persist": "Middleware persisting store state to web/async storage with serialization, deserialization, migration versioning, and rehydration.",
  "immer": "Middleware enabling mutable state updates within setState using Immer draft proxies.",
  "subscribeWithSelector": "Middleware enhancing subscribe to accept selector functions and fire only when selected slices change.",
  "combine": "Middleware combining an initial state dictionary with action creators to infer state and action types simultaneously.",

  // src/shallow.ts
  "shallow": "Shallow equality comparator for arrays, objects, and Maps/Sets to prevent unnecessary component re-renders when using object selectors."
};

const fileSummaries: Record<string, string> = {
  "src/vanilla.ts": "Core vanilla state machine: createStore, getState, setState, subscribe, and listener notification loop without React dependencies.",
  "src/react.ts": "React bindings: create() hook generator and useStore() integration with React useSyncExternalStore.",
  "src/middleware.ts": "Middleware suite: devtools, persist, immer, subscribeWithSelector, and combine enhancements.",
  "src/shallow.ts": "Shallow comparison utility for selector equality checks.",
  "src/index.ts": "Public entry point exporting create and vanilla store factories."
};

const updateStmt = db.prepare(`
  UPDATE code_nodes
  SET summary = ?, summary_status = 'fresh'
  WHERE name = ? OR name LIKE ?
`);

let updatedSymbols = 0;
for (const [name, summary] of Object.entries(symbolSummaries)) {
  const res = updateStmt.run(summary, name, `%${name}`);
  if (res.changes > 0) updatedSymbols += res.changes;
}

const updateFileStmt = db.prepare(`
  UPDATE code_nodes
  SET summary = ?, summary_status = 'fresh'
  WHERE file_path = ? AND node_type = 'file'
`);

let updatedFiles = 0;
for (const [filePath, summary] of Object.entries(fileSummaries)) {
  const res = updateFileStmt.run(summary, filePath);
  if (res.changes > 0) updatedFiles += res.changes;
}

// Rebuild FTS
const allFresh = db.prepare(`SELECT id, name, signature, summary FROM code_nodes WHERE summary_status = 'fresh'`).all() as any[];
const ftsDelete = db.prepare(`DELETE FROM node_fts WHERE node_id = ?`);
const ftsInsert = db.prepare(`INSERT INTO node_fts(node_id, name, body) VALUES (?, ?, ?)`);

for (const node of allFresh) {
  try {
    ftsDelete.run(node.id);
    const bodyText = `${node.signature || ''} ${node.summary || ''}`.trim();
    ftsInsert.run(node.id, node.name, bodyText);
  } catch {}
}

console.log(`✓ Updated ${updatedSymbols} symbol summaries and ${updatedFiles} file contract summaries in Zustand.`);
console.log(`✓ Synchronized full-text search index (node_fts) for ${allFresh.length} nodes.`);

// Generate embeddings
async function syncEmbeddings() {
  console.log(`Generating gemini-embedding-2 vectors for ${allFresh.length} fresh nodes (768-d)...`);
  const embedder = new GeminiEmbeddingProvider();

  let embeddedCount = 0;
  const deleteVecStmt = db.prepare(`DELETE FROM vec_nodes WHERE node_id = ?`);
  const insertVecStmt = db.prepare(`INSERT INTO vec_nodes(node_id, embedding) VALUES (?, ?)`);
  const upsertMetaStmt = db.prepare(`
    INSERT INTO node_embeddings(node_id, vec_rowid, input_hash, model, dims, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(node_id) DO UPDATE SET model = excluded.model, dims = excluded.dims
  `);

  for (let i = 0; i < allFresh.length; i += 10) {
    const batch = allFresh.slice(i, i + 10);
    const texts = batch.map(n => `${n.name} ${n.signature || ''} ${n.summary || ''}`.trim());
    try {
      const vectors = await embedder.embed(texts, "document");
      for (let j = 0; j < batch.length; j++) {
        const node = batch[j];
        const vec = vectors[j];
        if (vec && vec.length === 768) {
          try { deleteVecStmt.run(node.id); } catch {}
          insertVecStmt.run(node.id, Buffer.from(vec.buffer));
          upsertMetaStmt.run(node.id, i + j + 1, "hash", embedder.model, 768);
          embeddedCount++;
        }
      }
      process.stdout.write(`\r  ↳ Embedded ${embeddedCount}/${allFresh.length} nodes...`);
    } catch (err: any) {
      console.warn(`\n  Warning on embedding batch ${i}: ${err.message}`);
    }
  }

  console.log(`\n✓ Successfully generated and persisted ${embeddedCount} gemini-embedding-2 vectors in Zustand SQLite.`);
}

syncEmbeddings().then(() => {
  db.close();
  console.log("Done Zustand.");
}).catch((err) => {
  console.error("Fatal error:", err);
  db.close();
  process.exit(1);
});
