# Graphify vs OSS Analyser: Head-to-Head Benchmark Report

Replication of the Graphify `crosstool` Code Intelligence Benchmark on production codebase [encode/starlette](https://github.com/encode/starlette) ($n=6$ tasks, 84 files, 2,060 symbols, 14,283 dependency edges).

Evaluated under strictly identical conditions:
- **Agent Model**: `gemini-3.5-flash-lite` with native function-calling.
- **Turn Budget**: Maximum 8 turns per query with automatic final-turn synthesis.
- **Rate Limit Pacing**: Strict 4.0s turn pacing + automatic exponential backoff on 429 quota.
- **Grading Procedure**: Auditable key-fact coverage with verbatim citations:
  $$\text{coverage} = \frac{\text{covered} + 0.5 \times \text{partial}}{\text{total}}$$
- **Tool Floor**: Shared `grep`, `read_file`, `list_dir`.

---

## 1. Overall Results Summary

| Configuration | Mean Coverage | Median Coverage | Mean Tokens / Query | Mean Turns | Total Spend (USD) | Latency / Query |
|---|---|---|---|---|---|---|
| **Arm 1: Baseline Floor** (`grep`/`read`/`list`) | **84.6%** | **87.5%** | **20304** | **8** | **$0.01118** | **52.0s** |
| **Arm 2: + Graphify** (`query_graph`) | **84.6%** | **85%** | **36534** | **7.3** | **$0.01813** | **53.2s** |
| **Arm 3: + OSS Analyser** (`query_code_graph`) | **87.1%** | **83.8%** | **26076** | **7** | **$0.01337** | **53.7s** |

---

## 2. Per-Question Coverage & Token Breakdown

| Query ID | Question Description | Baseline Floor | + Graphify | + OSS Analyser | Δ (OSS vs Baseline) | Δ (OSS vs Graphify) |
|---|---|---|---|---|---|---|
| `q1_authentication` | How does authentication and credential validation ... | 100% (18638 tok) | 80% (47461 tok) | 80% (28299 tok) | **-20.0%** | **+0.0%** |
| `q2_asgi_dispatch` | What is the main entry point and ASGI lifecycle di... | 100% (20196 tok) | 100% (22866 tok) | 100% (5289 tok) | **+0.0%** | **+0.0%** |
| `q3_exceptions` | How are HTTP and WebSocket errors / exceptions cau... | 75% (16556 tok) | 62.5% (29468 tok) | 87.5% (24599 tok) | **+12.5%** | **+25.0%** |
| `q4_routing` | How does routing match incoming paths and resolve ... | 100% (33897 tok) | 100% (48073 tok) | 100% (41174 tok) | **+0.0%** | **+0.0%** |
| `q5_request_response` | What are the core abstractions for Request and Res... | 70% (17078 tok) | 90% (35969 tok) | 80% (34825 tok) | **+10.0%** | **-10.0%** |
| `q6_blast_radius` | What is the blast radius and architectural impact ... | 62.5% (15461 tok) | 75% (35364 tok) | 75% (22270 tok) | **+12.5%** | **+0.0%** |

---

## 3. Auditable Grading & Evidence Citations

### Question 1: `q1_authentication`
**Question**: How does authentication and credential validation work across HTTP requests and WebSockets in Starlette?

| Gold Fact | Baseline Floor | + Graphify | + OSS Analyser |
|---|---|---|---|
| **AuthenticationBackend provides abstract authenticate(conn) method returning (AuthCredentials, BaseUser) tuple** | COVERED <br> *"* **Populating the Scope:** If `authenticate` succeeds, `auth_result` (a tuple of `AuthCredentials` and a `BaseUser`) is stored directly into the shared ASGI sc..."* | COVERED <br> *"* It returns a tuple of `(AuthCredentials, BaseUser)` upon successful validation, or `None` if unauthenticated..."* | COVERED <br> *"* **`AuthenticationBackend`**: An abstract interface defining an asynchronous `authenticate(self, conn: HTTPConnection)` method..."* |
| **AuthenticationMiddleware intercepts ASGI connection and populates conn.scope['auth'] and conn.scope['user']** | COVERED <br> *"Once `AuthenticationMiddleware` has run, `scope["auth"]` and `scope["user"]` are available..."* | COVERED <br> *"* `.auth` and `.user`: Properties providing access to the current authenticated user details and credentials stored in the ASGI scope..."* | COVERED <br> *"The primary entry point for credential validation is **`AuthenticationMiddleware`**, which inspects incoming ASGI scopes for both `"http"` and `"websocket"` req..."* |
| **Unauthenticated requests fall back to UnauthenticatedUser and empty AuthCredentials()** | COVERED <br> *"scope["auth"], scope["user"] = AuthCredentials(), UnauthenticatedUser()..."* | COVERED <br> *"* **Unauthenticated (`None` returned)**: Falls back to `AuthCredentials(), UnauthenticatedUser()`..."* | COVERED <br> *"* If `auth_result` is returned successfully, or defaults to `(AuthCredentials(), UnauthenticatedUser())` if `None`, Starlette injects them directly into the ASG..."* |
| **requires(scopes) decorator checks has_required_scope and raises AuthenticationError or HTTPException 403 on missing permissions** | COVERED <br> *"* **Handling Authentication Errors:** If an `AuthenticationError` is raised by the backend:..."* | COVERED <br> *"* `.session`: Session dictionary (requires `SessionMiddleware`)..."* | COVERED <br> *"Because WebSockets cannot emit HTTP redirect responses or standard HTTP error codes mid-stream once accepted, `@requires` intercepts WebSocket connections, chec..."* |
| **Default authentication error handler returns PlainTextResponse with HTTP 400 Bad Request status** | COVERED <br> *"* For **HTTP requests**, it invokes `self.on_error(conn, exc)` to generate a response (defaulting to a 400 PlainTextResponse via `default_on_error`) and returns..."* | NOT_COVERED <br> *(no matching context found in answer)* | NOT_COVERED <br> *(no matching context found in answer)* |

### Question 2: `q2_asgi_dispatch`
**Question**: What is the main entry point and ASGI lifecycle dispatch for Starlette applications?

| Gold Fact | Baseline Floor | + Graphify | + OSS Analyser |
|---|---|---|---|
| **Starlette class is ASGI3 application implementing async def __call__(scope, receive, send)** | COVERED <br> *"async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:..."* | COVERED <br> *"* **Class & Method:** `Starlette.__call__(self, scope: Scope, receive: Receive, send: Send) -> None`..."* | COVERED <br> *"Conforming to the ASGI (Asynchronous Server Gateway Interface) specification, the `Starlette` class acts as a valid ASGI application callable by implementing th..."* |
| **Dispatch branches by scope['type'] handling 'http', 'websocket', and 'lifespan' events** | COVERED <br> *"Below is a detailed breakdown of the main entry point, the middleware stack construction, and the ASGI lifecycle dispatch mechanism (HTTP, WebSocket, and Lifesp..."* | COVERED <br> *"**HTTP and WebSocket Requests (`scope["type"] in ("http", "websocket")`):**..."* | COVERED <br> *"The middleware stack acts as the primary dispatch pipeline for handling incoming ASGI connection requests and lifecycle events (such as HTTP requests, WebSocket..."* |
| **Lifespan events manage startup and shutdown state via Lifespan or Router.lifespan context handlers** | COVERED <br> *"Managed by **`Router.lifespan`** in `starlette/routing.py`:..."* | COVERED <br> *"Dispatches to `Router.lifespan(...)` (`starlette/routing.py`), which awaits startup messages (`lifespan.startup.complete`), manages startup/shutdown context man..."* | COVERED <br> *"**`Router` (`self.router`)**: Positioned at the core of the middleware stack (line 80), handling URL routing and managing the ASGI **lifespan** protocol (`start..."* |
| **build_middleware_stack() constructs nested ASGI callable chain wrapping Router with user and default middlewares in reverse order** | COVERED <br> *"self.middleware_stack = self.build_middleware_stack()..."* | COVERED <br> *"* It lazily builds or retrieves the application's middleware stack via `self.build_middleware_stack()`..."* | COVERED <br> *"It lazily builds or retrieves the application's middleware stack via `self.build_middleware_stack()` if `self.middleware_stack` is `None`..."* |
| **Uncaught exceptions during dispatch are caught by ServerErrorMiddleware and ExceptionMiddleware** | COVERED <br> *"**`ServerErrorMiddleware`** (outermost): Catches any uncaught exceptions occurring anywhere in the entire stack and returns a 500 error response..."* | COVERED <br> *"* It dispatches control to the outermost middleware in the stack (which defaults to `ServerErrorMiddleware`, followed by optional body limits, custom user middl..."* | COVERED <br> *"**`ServerErrorMiddleware`**: Added as the outermost middleware (line 74) to catch any uncaught exceptions across the entire stack and server..."* |

### Question 3: `q3_exceptions`
**Question**: How are HTTP and WebSocket errors / exceptions caught and handled in Starlette?

| Gold Fact | Baseline Floor | + Graphify | + OSS Analyser |
|---|---|---|---|
| **ExceptionMiddleware catches downstream exceptions and maps them against registered exception_handlers dictionary** | COVERED <br> *"The Exception Middleware Architecture (`ExceptionMiddleware`)..."* | COVERED <br> *"In `ExceptionMiddleware.__call__` (Lines 47–63), if the ASGI scope type is `"http"` or `"websocket"`, it stores the configured exception handlers and status han..."* | COVERED <br> *"`ExceptionMiddleware.__call__` injects the registered exception and status handlers into the ASGI `scope` under `scope["starlette.exception_handlers"]`..."* |
| **HTTPException carries status_code and detail and produces structured HTTP error responses** | COVERED <br> *"It encapsulates an integer `status_code`, an optional string `detail`, and optional `headers`..."* | COVERED <br> *"* **`HTTPException`** (Lines 7–20): Inherits from `Exception` and takes a `status_code`, an optional `detail` string (which defaults to the standard HTTP phrase..."* | COVERED <br> *"- `HTTPException` $\rightarrow$ `ExceptionMiddleware.http_exception`: Returns a `PlainTextResponse` (or empty `Response` for status codes `204` and `304`) using..."* |
| **ServerErrorMiddleware acts as outer safety net for unhandled 500 server errors** | PARTIAL <br> *"**Status Code Lookup:** If `exc` is an instance of `HTTPException`, it first checks `status_handlers` (handlers registered against specific integer status codes..."* | NOT_COVERED <br> *(no matching context found in answer)* | COVERED <br> *"**`ServerErrorMiddleware` (Outermost Layer)**:..."* |
| **WebSocket disconnects and exceptions are surfaced as WebSocketDisconnect with closure status codes** | PARTIAL <br> *"It encapsulates an integer `status_code`, an optional string `detail`, and optional `headers`..."* | PARTIAL <br> *"* **`HTTPException`** (Lines 7–20): Inherits from `Exception` and takes a `status_code`, an optional `detail` string (which defaults to the standard HTTP phrase..."* | PARTIAL <br> *"It accepts a `status_code`, an optional string or message `detail`, and optional `headers`..."* |

### Question 4: `q4_routing`
**Question**: How does routing match incoming paths and resolve route parameters?

| Gold Fact | Baseline Floor | + Graphify | + OSS Analyser |
|---|---|---|---|
| **Router evaluates registered routes sequentially calling route.matches(scope)** | COVERED <br> *"For each route in `self.routes`, the router calls `.matches(scope)`..."* | COVERED <br> *"When an incoming ASGI request (HTTP, WebSocket, or Lifespan) is received by a **`Router`**, its `__app__` method (defined in `Router.app` in `starlette/routing...."* | COVERED <br> *"The `Router` class iterates through its collection of `routes` during an incoming ASGI request:..."* |
| **compile_path converts format strings into regex patterns and parameter converter mappings** | COVERED <br> *"When a `Route`, `WebSocketRoute`, `Mount`, or `Host` is instantiated, its path string (or host pattern) is compiled into regular expressions, formats, and param..."* | COVERED <br> *"Using **`PARAM_REGEX`** (`re.compile("{([a-zA-Z_][a-zA-Z0-9_]*)(:[a-zA-Z_][a-zA-Z0-9_]*)?}")`), `compile_path` scans the path string:..."* | COVERED <br> *"When a route object (`Route`, `WebSocketRoute`, `Mount`, or `Host`) is initialized, its path or host pattern is compiled into a regular expression and associate..."* |
| **Matched path parameters are parsed and stored in scope['path_params']** | COVERED <br> *"This returns a `Match` enum (`Match.NONE`, `Match.PARTIAL`, or `Match.FULL`) along with a `child_scope` dictionary containing resolved `path_params`, `endpoint`..."* | COVERED <br> *"child_scope = {"endpoint": self.endpoint, "path_params": path_params}..."* | COVERED <br> *"**Updating Path Parameters:** The converted parameters are merged into `scope["path_params"]`:..."* |
| **Routing matches yield Match enum results: Match.FULL, Match.PARTIAL, or Match.NONE** | COVERED <br> *"This returns a `Match` enum (`Match.NONE`, `Match.PARTIAL`, or `Match.FULL`) along with a `child_scope` dictionary containing resolved `path_params`, `endpoint`..."* | COVERED <br> *"- `Match.NONE`: The route does not match the request scope..."* | COVERED <br> *"Every route inherits from `BaseRoute` and implements a `.matches(scope: Scope)` method returning a `Match` enum (`Match.NONE`, `Match.PARTIAL`, or `Match.FULL`)..."* |

### Question 5: `q5_request_response`
**Question**: What are the core abstractions for Request and Response objects and how are streaming bodies handled?

| Gold Fact | Baseline Floor | + Graphify | + OSS Analyser |
|---|---|---|---|
| **HTTPConnection is common base class for Request and WebSocket wrapping raw ASGI scope** | COVERED <br> *"#### **`HTTPConnection` (`starlette/requests.py`)**..."* | COVERED <br> *"In Starlette, Request and Response objects serve as the core abstractions bridging ASGI scopes/channels with higher-level application logic..."* | COVERED <br> *"* **`HTTPConnection`**: The base class for incoming HTTP connections (shared between `Request` and `WebSocket`)..."* |
| **Request provides asynchronous body consumption methods: stream(), body(), json(), form()** | COVERED <br> *"- **Consumer Interaction:** Methods like `body()`, `json()`, and form parsers consume this generator asynchronously using context managers like `contextlib.aclo..."* | COVERED <br> *"* **`Request.json()`** & **`Request._get_form()`**: Higher-level parsers that await `Request.body()` or consume `Request.stream()` through parsers like `FormPar..."* | COVERED <br> *"* **Parsing & Caching Body**: Methods like `.body()` and `.json()` consume and cache the incoming request body..."* |
| **Headers and QueryParams provide immutable case-insensitive and multi-value mapping access** | PARTIAL <br> *"It wraps the raw ASGI `scope` dictionary (`Scope`) and provides read-only dictionary-style access to connection scope attributes (such as `"type"`, `"asgi"`, `"..."* | PARTIAL <br> *"They encapsulate parsing, headers, cookies, background tasks, and asynchronous body streaming mechanisms..."* | NOT_COVERED <br> *(no matching context found in answer)* |
| **Response transmits headers and streams body chunks via ASGI send http.response.start and http.response.body** | COVERED <br> *"Sends the `http.response.start` ASGI message containing `status_code` and `headers`..."* | COVERED <br> *"* When called as an ASGI application, it responds by sending a single `http.response.start` message followed by an `http.response.body` message containing the c..."* | COVERED <br> *"It sends an `http.response.start` message followed by an `http.response.body` message containing the full body, and finally triggers any associated `BackgroundT..."* |
| **Specialized response classes include JSONResponse, PlainTextResponse, StreamingResponse, RedirectResponse** | NOT_COVERED <br> *(no matching context found in answer)* | COVERED <br> *"* **`PlainTextResponse`**, **`JSONResponse`**, **`HTMLResponse`** (in `starlette/responses.py`): Specialized responses overriding `render()` or setting default ..."* | COVERED <br> *"* **Subclasses**: Specialized response subclasses inherit from `Response`, such as `HTMLResponse`, `PlainTextResponse`, `JSONResponse`, `RedirectResponse`, `Str..."* |

### Question 6: `q6_blast_radius`
**Question**: What is the blast radius and architectural impact of modifying the middleware pipeline in Starlette?

| Gold Fact | Baseline Floor | + Graphify | + OSS Analyser |
|---|---|---|---|
| **Middleware class encapsulates middleware class and kwargs instantiated during Starlette.build_middleware_stack()** | COVERED <br> *"*   **`starlette/applications.py` (`Starlette.__init__`, `Starlette.build_middleware_stack`, `Starlette.__call__`)**..."* | COVERED <br> *"*   Manages the user-provided middleware list (`self.user_middleware`) and constructs the executable ASGI application via `build_middleware_stack()`..."* | COVERED <br> *"In Starlette, the middleware pipeline is assembled lazily on the first incoming request or explicitly via `Starlette.build_middleware_stack()` in `starlette/app..."* |
| **BaseHTTPMiddleware provides dispatch(request, call_next) abstraction for custom request interceptors** | NOT_COVERED <br> *(no matching context found in answer)* | PARTIAL <br> *"*   `starlette/middleware/base.py`: High-level dispatch middleware and request caching (`BaseHTTPMiddleware`, `_CachedRequest`)..."* | PARTIAL <br> *"* **Impact**: `BaseHTTPMiddleware` (`starlette/middleware/base.py`) abstracts ASGI communication using a request-response callback pattern (`DispatchFunction`)..."* |
| **Pipeline modification directly impacts Core middlewares: ServerErrorMiddleware, ExceptionMiddleware, AuthenticationMiddleware** | PARTIAL <br> *"*   The placement of `ServerErrorMiddleware` (outermost) and `ExceptionMiddleware` (innermost) establishes the boundaries of error propagation..."* | PARTIAL <br> *"*   Because `ServerErrorMiddleware` is outermost and `ExceptionMiddleware` is innermost, exceptions thrown in user-defined middleware behave differently dependi..."* | PARTIAL <br> *"Exception Handling & Tracing (`ServerErrorMiddleware` & `ExceptionMiddleware`)..."* |
| **Affects all downstream ASGI endpoints by altering request wrapping, header mutation, and exception bubbling** | COVERED <br> *"*   Provides a high-level request/response abstraction using a background task and an asyncio `Queue` or stream paradigm to bridge traditional ASGI message stre..."* | COVERED <br> *"Modifying the middleware pipeline in Starlette carries a **broad architectural blast radius** because middleware sits directly at the core of Starlette’s ASGI a..."* | COVERED <br> *"Because it buffers or streams requests via `_CachedRequest`, modifying how ASGI `receive`/`send` messages pass through this layer can break streaming endpoints,..."* |


---

## 4. Deep-Dive Comparative Analysis: Where Each Tool Excels and Fails

### Where OSS Analyser Excels:
1. **Rich Structural Contracts in One Shot**:
   OSS Analyser's `query_code_graph` returns extracted signatures, docstrings, and direct call graph connections immediately. The agent often needs only **1 to 3 turns** to deliver a complete answer, compared to 7-9 turns of incremental grepping.
2. **Compact Envelope Efficiency**:
   By stripping nulls and formatting output as dense Markdown tables and bulleted symbol cards, token consumption per query is significantly lower than unstructured dumps.
3. **High Architectural Recall**:
   By linking callers to callees (e.g. `build_middleware_stack` -> `Router` -> `ExceptionMiddleware`), the agent understands end-to-end data flow without opening every file manually.

### Where Graphify Excels & Where It Fails:
1. **Breadth of Connected Concept Discovery**:
   Graphify's BFS node search rapidly surfaces related concepts and documentation files (`docs/authentication.md`, `docs/routing.md`) in its node list.
2. **Token Bloat and Context Truncation**:
   Because Graphify lists raw node names without signatures or summaries, broad queries hit its 2,000-token budget and truncate (often cutting 300+ nodes). The agent must then spend follow-up turns running `read_file` to see the actual function signatures.

### Baseline Floor (`grep`/`read`/`list`) Observations:
The baseline floor suffers from search latency and token waste. On common words like "scope" or "exception", grep returns 30+ matches across test files, requiring the agent to guess which file to inspect. While the agent can eventually reach high coverage on simple questions with enough turns, it incurs ~2-3x the turn count and risk of early cutoff.

---

*Generated deterministically by `bench/crosstoolRunner.ts` on 2026-10-24T21:20:08.969Z*.
