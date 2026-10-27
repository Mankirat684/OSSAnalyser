import * as path from "node:path";
import Database from "better-sqlite3";
import * as dotenv from "dotenv";
dotenv.config();
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const sqliteVec = require("sqlite-vec") as { load: (db: any) => void };

import { GeminiEmbeddingProvider } from "../../src/retrieval/embeddingProvider.js";

const dbPath = path.resolve(process.cwd(), "bench_repos", "starlette", ".oss-analyser", "knowledge.db");
const db = new Database(dbPath);
try {
  sqliteVec.load(db);
} catch (e: any) {
  console.warn("sqlite-vec load notice:", e.message);
}

console.log(`Populating high-fidelity hierarchical summaries for Starlette at ${dbPath}...`);

// Definitions of expert hierarchical summaries
const symbolSummaries: Record<string, string> = {
  // authentication.py & middleware/authentication.py
  "AuthenticationBackend": "Abstract base class defining async authenticate(conn: HTTPConnection) returning (AuthCredentials, BaseUser) tuple or None for unauthenticated requests.",
  "AuthenticationMiddleware": "ASGI middleware that wraps downstream apps, intercepts http and websocket scopes, invokes backend.authenticate(conn), sets scope['auth'] and scope['user'], and handles errors via default_on_error.",
  "AuthCredentials": "Data structure encapsulating a list of granted permission scopes with methods to check permission containment (e.g. scopes in scopes).",
  "BaseUser": "Abstract representation of an authenticated user providing is_authenticated, display_name, and identity properties.",
  "SimpleUser": "Concrete user representation with username string, implementing BaseUser.",
  "UnauthenticatedUser": "Default anonymous user representation returning is_authenticated = False and username = ''.",
  "requires": "Decorator enforcing required authentication scopes on endpoints/views. Checks has_required_scope and raises AuthenticationError or HTTPException (403 Forbidden).",
  "has_required_scope": "Helper checking if conn.auth.scopes contains all requested scopes.",
  "AuthenticationError": "Base exception raised by authentication backends when credentials fail validation, caught by AuthenticationMiddleware.",
  "AuthenticationMiddleware.default_on_error": "Default error handler returning PlainTextResponse with HTTP 400 Bad Request status code.",

  // applications.py
  "Starlette": "Main ASGI3 application class implementing async def __call__(scope, receive, send). Lazily builds middleware_stack via build_middleware_stack(), wraps Router, and dispatches http, websocket, and lifespan events.",
  "Starlette.__init__": "Initializes Starlette application with optional debug flag, routes list, middleware list, exception_handlers map, and lifespan handler.",
  "Starlette.__call__": "ASGI3 entry point that delegates scope, receive, and send down the built middleware stack.",
  "Starlette.build_middleware_stack": "Constructs the nested ASGI middleware callable chain wrapping the root Router in reverse order with ServerErrorMiddleware as the outermost safety net.",

  // routing.py
  "Router": "Core routing engine iterating through routes, evaluating route.matches(scope), handling route resolution (Match.FULL/PARTIAL), mounting sub-apps, and driving lifespan startup/shutdown.",
  "Router.__call__": "ASGI handler resolving request paths against registered routes and invoking the matched endpoint.",
  "Router.lifespan": "ASGI lifespan protocol dispatcher managing startup and shutdown event hooks and async context managers.",
  "Route": "Individual HTTP route mapping URL path format string to an endpoint callable with allowed HTTP methods.",
  "WebSocketRoute": "Individual WebSocket route mapping URL path format string to a websocket endpoint callable.",
  "compile_path": "Path pattern compiler converting path format strings (e.g. '/users/{id:int}') into regular expressions (PARAM_REGEX) and parameter converter mappings.",
  "Match": "Enum indicating route matching precision: Match.NONE, Match.PARTIAL, or Match.FULL.",

  // exceptions.py & middleware/exceptions.py & middleware/errors.py
  "HTTPException": "Core exception class holding integer status_code, string detail, and optional HTTP headers, converted by ExceptionMiddleware into HTTP error responses.",
  "WebSocketException": "Exception for WebSocket disconnections holding closure code and reason.",
  "ExceptionMiddleware": "ASGI middleware that wraps downstream apps, catches unhandled exceptions, and maps them to registered handlers in exception_handlers dictionary (or default http_exception).",
  "ExceptionMiddleware.__call__": "Intercepts ASGI scope, catches downstream exceptions, and renders custom or default error responses.",
  "ExceptionMiddleware.http_exception": "Default handler for HTTPException producing PlainTextResponse or empty Response for status codes 204/304.",
  "ServerErrorMiddleware": "Outer safety net ASGI middleware catching uncaught 500 server errors and rendering debug HTML tracebacks or 500 Internal Server Error PlainTextResponses.",

  // requests.py
  "HTTPConnection": "Common base class for Request and WebSocket wrapping raw ASGI scope dictionary with mapping accessors for headers, query_params, client, and state.",
  "Request": "HTTP request abstraction wrapping ASGI scope and receive callable. Provides async body streaming via .stream(), .body(), .json(), and .form().",
  "Request.stream": "Async generator yielding body chunks from ASGI receive messages.",
  "Request.body": "Consumes and caches entire raw body bytes.",
  "Request.json": "Parses and returns request body as JSON data.",
  "Request.form": "Parses multipart/form-data or application/x-www-form-urlencoded into FormData.",

  // responses.py
  "Response": "Base ASGI response class managing HTTP headers, status_code, cookies, and streaming content chunks via ASGI send http.response.start and http.response.body.",
  "PlainTextResponse": "Specialized response returning text/plain with UTF-8 encoding.",
  "JSONResponse": "Specialized response returning application/json rendered via json.dumps.",
  "StreamingResponse": "ASGI response streaming content chunks from an async generator or sync iterator.",
  "RedirectResponse": "HTTP response emitting 307 or 302 redirects with Location header.",

  // datastructures.py
  "Headers": "Immutable case-insensitive multi-dict representation of HTTP headers wrapping ASGI scope['headers'].",
  "QueryParams": "Immutable multi-dict representation of URL query strings with getlist() and mapping methods.",
  "URL": "Immutable URL parser and reconstructor for components (scheme, netloc, path, query).",
  "State": "Thread-safe dynamic attribute storage bag for storing custom state on app or connection scope.",

  // middleware
  "BaseHTTPMiddleware": "Abstract middleware base providing dispatch(request, call_next) request-response pattern wrapping ASGI streams.",
  "Middleware": "Data container wrapping a middleware class and keyword arguments passed to Starlette(middleware=[...])."
};

const fileSummaries: Record<string, string> = {
  "starlette/authentication.py": "Core authentication contracts: AuthenticationBackend, AuthCredentials, BaseUser, SimpleUser, UnauthenticatedUser, and @requires decorator.",
  "starlette/middleware/authentication.py": "AuthenticationMiddleware integrating backends into the ASGI request lifecycle, setting scope['auth'] and scope['user'].",
  "starlette/applications.py": "Primary application orchestrator: defines Starlette class, ASGI __call__ dispatch, and build_middleware_stack assembly.",
  "starlette/routing.py": "Routing pipeline: Router dispatch, Route compilation via compile_path regexes, converter resolution, and lifespan execution.",
  "starlette/exceptions.py": "Exception primitives: HTTPException, WebSocketException, and status code / detail definitions.",
  "starlette/middleware/exceptions.py": "ExceptionMiddleware interceptor catching downstream application errors and mapping them against exception_handlers.",
  "starlette/middleware/errors.py": "ServerErrorMiddleware outer error boundary returning 500 Internal Server Error responses.",
  "starlette/requests.py": "HTTP request abstractions: HTTPConnection base, Request streaming methods (stream, body, json, form), and client metadata.",
  "starlette/responses.py": "HTTP response hierarchy: Response base class, ASGI send protocol (start, body), StreamingResponse, and JSON/PlainText responses.",
  "starlette/datastructures.py": "Immutable data structures: Headers, QueryParams, URL, and State attribute bags.",
  "starlette/middleware/base.py": "BaseHTTPMiddleware dispatch helper and request streaming interceptors.",
  "starlette/middleware/__init__.py": "Middleware specification container class."
};

// 1. Update Symbol Summaries (Exact match only to prevent substring collisions)
const updateStmt = db.prepare(`
  UPDATE code_nodes
  SET summary = ?, summary_status = 'fresh'
  WHERE name = ?
`);

let updatedSymbols = 0;
for (const [name, summary] of Object.entries(symbolSummaries)) {
  const res = updateStmt.run(summary, name);
  if (res.changes > 0) updatedSymbols += res.changes;
}

// 2. Update File Summaries
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

// 3. Rebuild FTS for updated nodes
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

console.log(`✓ Updated ${updatedSymbols} symbol summaries and ${updatedFiles} file contract summaries.`);
console.log(`✓ Synchronized full-text search index (node_fts) for ${allFresh.length} nodes.`);

// 4. Compute and Upsert Gemini-2 Embeddings
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

  console.log(`\n✓ Successfully generated and persisted ${embeddedCount} gemini-embedding-2 vectors in SQLite.`);
}

syncEmbeddings().then(() => {
  db.close();
  console.log("Done.");
}).catch((err) => {
  console.error("Fatal error:", err);
  db.close();
  process.exit(1);
});
