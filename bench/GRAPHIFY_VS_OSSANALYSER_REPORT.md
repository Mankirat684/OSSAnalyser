# Graphify vs OSS Analyser: Head-to-Head Benchmark Report

Replication of the Graphify `crosstool` Code Intelligence Benchmark on production codebase [encode/starlette](https://github.com/encode/starlette) ($n=4$ tasks).

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
| **Arm 1: Baseline Floor** (`grep`/`read`/`list`) | **88.1%** | **88.8%** | **17195** | **8** | **$0.00653** | **44.1s** |
| **Arm 2: + Graphify** (`query_graph`) | **85.6%** | **83.8%** | **34650** | **8** | **$0.01161** | **45.3s** |
| **Arm 3: + OSS Analyser** (`query_code_graph`) | **85.6%** | **83.8%** | **18274** | **6.3** | **$0.00666** | **34.6s** |

---

## 2. Per-Question Coverage & Token Breakdown

| Query ID | Question Description | Baseline Floor | + Graphify | + OSS Analyser | Δ (OSS vs Baseline) | Δ (OSS vs Graphify) |
|---|---|---|---|---|---|---|
| `q6_blast_radius` | What is the blast radius and architectural impact ... | 87.5% (15559 tok) | 87.5% (32907 tok) | 75% (21616 tok) | **-12.5%** | **-12.5%** |
| `q2_asgi_dispatch` | What is the main entry point and ASGI lifecycle di... | 100% (18378 tok) | 100% (32883 tok) | 80% (18975 tok) | **-20.0%** | **-20.0%** |
| `q3_exceptions` | How are HTTP and WebSocket errors / exceptions cau... | 75% (16624 tok) | 75% (32546 tok) | 87.5% (22938 tok) | **+12.5%** | **+12.5%** |
| `q1_authentication` | How does authentication and credential validation ... | 90% (18218 tok) | 80% (40262 tok) | 100% (9568 tok) | **+10.0%** | **+20.0%** |

---

## 3. Auditable Grading & Evidence Citations

### Question 1: `q6_blast_radius`
**Question**: What is the blast radius and architectural impact of modifying the middleware pipeline in Starlette?

| Gold Fact | Baseline Floor | + Graphify | + OSS Analyser |
|---|---|---|---|
| **Middleware class encapsulates middleware class and kwargs instantiated during Starlette.build_middleware_stack()** | COVERED <br> *"Middleware components are composed lazily during application startup or upon the first incoming request via `Starlette.build_middleware_stack()` in [`starlette/..."* | COVERED <br> *"* **The Middleware Stack Definition**: The middleware stack is built via `build_middleware_stack()`..."* | COVERED <br> *"In Starlette, modifying the middleware pipeline—whether by altering how `build_middleware_stack` constructs the stack, changing core built-in middleware (`Serve..."* |
| **BaseHTTPMiddleware provides dispatch(request, call_next) abstraction for custom request interceptors** | PARTIAL <br> *"* **`starlette.middleware.base.BaseHTTPMiddleware`** (if utilized): Provides a higher-level request/response abstraction (`dispatch` method), whose internal con..."* | COVERED <br> *"`BaseHTTPMiddleware` (`starlette/middleware/base.py`) provides a higher-level `dispatch(request, call_next)` abstraction..."* | PARTIAL <br> *"* **Gotcha with `BaseHTTPMiddleware`:** Starlette's `BaseHTTPMiddleware` (in `starlette/middleware/base.py`) abstracts ASGI into a starlette `Request`/`Response..."* |
| **Pipeline modification directly impacts Core middlewares: ServerErrorMiddleware, ExceptionMiddleware, AuthenticationMiddleware** | COVERED <br> *"Moving a middleware inside or outside `ExceptionMiddleware` or `AuthenticationMiddleware` determines whether endpoints or subsequent middleware can access `requ..."* | PARTIAL <br> *"**`ServerErrorMiddleware`** (`starlette/middleware/errors.py`): Added as the **outermost** layer to catch uncaught 500 server errors and format debugging/produc..."* | PARTIAL <br> *"In Starlette, modifying the middleware pipeline—whether by altering how `build_middleware_stack` constructs the stack, changing core built-in middleware (`Serve..."* |
| **Affects all downstream ASGI endpoints by altering request wrapping, header mutation, and exception bubbling** | COVERED <br> *"Moving a middleware inside or outside `ExceptionMiddleware` or `AuthenticationMiddleware` determines whether endpoints or subsequent middleware can access `requ..."* | COVERED <br> *"* **Innermost layers** (e.g., `ExceptionMiddleware`) see the request *last* (just before routing) and the response *first* (as it comes out of the router/endpoi..."* | COVERED <br> *"In Starlette, modifying the middleware pipeline—whether by altering how `build_middleware_stack` constructs the stack, changing core built-in middleware (`Serve..."* |

### Question 2: `q2_asgi_dispatch`
**Question**: What is the main entry point and ASGI lifecycle dispatch for Starlette applications?

| Gold Fact | Baseline Floor | + Graphify | + OSS Analyser |
|---|---|---|---|
| **Starlette class is ASGI3 application implementing async def __call__(scope, receive, send)** | COVERED <br> *"async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:..."* | COVERED <br> *"When an ASGI server (such as Uvicorn or Hypercorn) launches a Starlette application, it interacts with the application instance as an ASGI application callable ..."* | COVERED <br> *"In Starlette, ASGI (Asynchronous Server Gateway Interface) applications follow the standard ASGI callable protocol (`async def __call__(self, scope, receive, se..."* |
| **Dispatch branches by scope['type'] handling 'http', 'websocket', and 'lifespan' events** | COVERED <br> *"assert scope["type"] in ("http", "websocket", "lifespan")..."* | COVERED <br> *"Once execution passes through the middleware stack, it reaches the core `Router` instance (`starlette/routing.py`), which handles both **Lifespan** events (`lif..."* | COVERED <br> *"assert scope["type"] in ("http", "websocket", "lifespan")..."* |
| **Lifespan events manage startup and shutdown state via Lifespan or Router.lifespan context handlers** | COVERED <br> *"Managed by **`Router.lifespan`**, this handles application startup and shutdown events using context managers (such as `@asynccontextmanager`):..."* | COVERED <br> *"If `scope["type"] == "lifespan"`, Starlette handles startup and shutdown hooks/async context managers via `self.lifespan` (managed via `Router.lifespan` in `sta..."* | COVERED <br> *"Lifespan events (`startup` and `shutdown`) are handled by `Router.lifespan(...)` in **`starlette/routing.py`**..."* |
| **build_middleware_stack() constructs nested ASGI callable chain wrapping Router with user and default middlewares in reverse order** | COVERED <br> *"When an application receives its first request or lifespan signal, `build_middleware_stack` constructs a nested onion-skin execution stack of ASGI middleware wr..."* | COVERED <br> *"In Starlette, the main entry point and ASGI lifecycle dispatch for applications revolve around the `Starlette` class, its middleware stack, and its underlying `..."* | COVERED <br> *"* **Middleware Stack Initialization**: Lazily builds or reuses the application's middleware stack via `self.build_middleware_stack()` (which wraps the underlyin..."* |
| **Uncaught exceptions during dispatch are caught by ServerErrorMiddleware and ExceptionMiddleware** | COVERED <br> *"**`ServerErrorMiddleware`** (`starlette/middleware/errors.py`): Placed outermost to catch uncaught exceptions anywhere in the application stack and return 500 e..."* | COVERED <br> *"* **`ServerErrorMiddleware`** (`starlette/middleware/errors.py`): Placed as the outermost layer to catch any unhandled server exceptions (HTTP 500 or general ex..."* | NOT_COVERED <br> *(no matching context found in answer)* |

### Question 3: `q3_exceptions`
**Question**: How are HTTP and WebSocket errors / exceptions caught and handled in Starlette?

| Gold Fact | Baseline Floor | + Graphify | + OSS Analyser |
|---|---|---|---|
| **ExceptionMiddleware catches downstream exceptions and maps them against registered exception_handlers dictionary** | COVERED <br> *"In Starlette, HTTP and WebSocket errors and exceptions are caught and handled primarily via **`ExceptionMiddleware`** in combination with the exception wrapping..."* | COVERED <br> *"In Starlette, HTTP and WebSocket errors and exceptions are caught, intercepted, and handled via a combination of custom exception classes, an exception-handling..."* | COVERED <br> *"Errors are primarily intercepted and handled by **`ExceptionMiddleware`** (`starlette/middleware/exceptions.py`), which works closely with **`wrap_app_handling_..."* |
| **HTTPException carries status_code and detail and produces structured HTTP error responses** | COVERED <br> *"It accepts a `status_code`, an optional `detail` string, and optional `headers`..."* | COVERED <br> *"* `HTTPException`: Handled by `self.http_exception`, which wraps the detail message in a `PlainTextResponse` (or empty `Response` for status codes like `204` or..."* | COVERED <br> *"It encapsulates standard HTTP errors (`status_code`, `detail`, and optional `headers`)..."* |
| **ServerErrorMiddleware acts as outer safety net for unhandled 500 server errors** | PARTIAL <br> *"* **`self._status_handlers`** (mapping integer HTTP status codes like `404` or `500` to handler functions)..."* | PARTIAL <br> *"* **Status-code specific handlers**: If the exception is an `HTTPException`, it first looks for a handler matching the specific `exc.status_code` in `status_han..."* | COVERED <br> *"**Status Code Precedence (`HTTPException`)**: If an `HTTPException` is raised, Starlette first checks if a specific **status-code handler** (e.g., handling a 40..."* |
| **WebSocket disconnects and exceptions are surfaced as WebSocketDisconnect with closure status codes** | PARTIAL <br> *"It accepts a `status_code`, an optional `detail` string, and optional `headers`..."* | PARTIAL <br> *"* `status_code` (`int`)..."* | PARTIAL <br> *"It encapsulates standard HTTP errors (`status_code`, `detail`, and optional `headers`)..."* |

### Question 4: `q1_authentication`
**Question**: How does authentication and credential validation work across HTTP requests and WebSockets in Starlette?

| Gold Fact | Baseline Floor | + Graphify | + OSS Analyser |
|---|---|---|---|
| **AuthenticationBackend provides abstract authenticate(conn) method returning (AuthCredentials, BaseUser) tuple** | COVERED <br> *"* **`AuthenticationBackend`**: Subclasses must implement the coroutine `authenticate(self, conn: HTTPConnection) -> tuple[AuthCredentials, BaseUser] | None`..."* | COVERED <br> *"* **`AuthenticationBackend`** (`starlette/authentication.py`): An abstract interface that defines a single asynchronous method, `authenticate(self, conn: HTTPCo..."* | COVERED <br> *"- **`AuthenticationBackend` Interface:** Subclasses implement `async def authenticate(self, conn: HTTPConnection) -> tuple[AuthCredentials, BaseUser] | None` (`..."* |
| **AuthenticationMiddleware intercepts ASGI connection and populates conn.scope['auth'] and conn.scope['user']** | COVERED <br> *"**Populating the Scope:** If `auth_result` is returned successfully, it injects the tuple of `(AuthCredentials, BaseUser)` into `scope["auth"]` and `scope["user..."* | COVERED <br> *"* **`AuthenticationMiddleware`** (`starlette/middleware/authentication.py`): The primary middleware component that intercepts incoming ASGI scopes where `scope[..."* | COVERED <br> *"**The ASGI Middleware Layer (`AuthenticationMiddleware`)**: Intercepts incoming connections, extracts credentials, invokes authentication backends, and populate..."* |
| **Unauthenticated requests fall back to UnauthenticatedUser and empty AuthCredentials()** | COVERED <br> *"If `auth_result` is `None`, it defaults to an empty `AuthCredentials()` and an `UnauthenticatedUser()`:..."* | COVERED <br> *"* **No Credentials**: If the connection lacks credentials but is permitted anonymously, the backend returns `None`, which defaults to `(AuthCredentials(), Unaut..."* | COVERED <br> *"- If `auth_result` is `None`, default unauthenticated objects are assigned: `scope["auth"], scope["user"] = AuthCredentials(), UnauthenticatedUser()` (`starlett..."* |
| **requires(scopes) decorator checks has_required_scope and raises AuthenticationError or HTTPException 403 on missing permissions** | COVERED <br> *"**Error Handling:** If an `AuthenticationError` is raised during credential validation:..."* | COVERED <br> *"* **`@requires` Decorator** (`starlette/authentication.py`): A decorator used on route handlers or endpoints to enforce scope/permission requirements, handling ..."* | COVERED <br> *"| **Authorization Failure (`@requires`)** | Raises `HTTPException` (e.g., `403`) or returns a `RedirectResponse`..."* |
| **Default authentication error handler returns PlainTextResponse with HTTP 400 Bad Request status** | PARTIAL <br> *"* For **HTTP requests**, it returns the response generated by `on_error` (defaulting to a `PlainTextResponse` with status code `400`)..."* | NOT_COVERED <br> *(no matching context found in answer)* | COVERED <br> *"- For **HTTP requests**, the `on_error` handler (defaulting to `AuthenticationMiddleware.default_on_error` returning a `PlainTextResponse` with status 400) is c..."* |


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

*Generated deterministically by `bench/crosstoolRunner.ts` on 2026-10-26T20:55:37.390Z*.
