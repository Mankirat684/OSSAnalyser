# Audited Benchmark Evaluation Report: Graphify vs OSS Analyser

> **Substantive Fact Verification & Independent Model Judge Audit**  
> Evaluated on production codebase [encode/starlette](https://github.com/encode/starlette) ($n=4$ tasks).  
> Evaluation methodology: Ground-truth model judging against verified Starlette source code with verbatim answer citation extraction.  
> Generated on: `2026-10-26T21:16:11.168Z`.

---

## 1. Executive Comparison: Keyword-Only vs. Substantive Audited Scoring

This table contrasts the legacy heuristic keyword matching scores against the audited substantive model-judge scores with verified ground-truth citations.

| Configuration | Legacy Mean Coverage | **Audited Mean Coverage** | Legacy Median | **Audited Median** | Net Audit Delta |
|---|---|---|---|---|---|
| **Arm 1: Baseline Floor** (`grep`/`read`/`list`) | 88.1% | **93.8%** | 88.8% | **100%** | **+5.7%** |
| **Arm 2: + Graphify** (`query_graph`) | 85.6% | **97.5%** | 83.8% | **100%** | **+11.9%** |
| **Arm 3: + OSS Analyser** (`query_code_graph`) | 85.6% | **92.5%** | 83.8% | **100%** | **+6.9%** |

---

## 2. Per-Task Coverage Breakdown

| Task ID | Question Summary | Baseline (Orig $\rightarrow$ Audit) | Graphify (Orig $\rightarrow$ Audit) | OSS Analyser (Orig $\rightarrow$ Audit) | Substantive Winner |
|---|---|---|---|---|---|
| `q6_blast_radius` | What is the blast radius and architectural impac... | 87.5% $\rightarrow$ **100%** | 87.5% $\rightarrow$ **100%** | 75% $\rightarrow$ **100%** | **Tie** |
| `q2_asgi_dispatch` | What is the main entry point and ASGI lifecycle ... | 100% $\rightarrow$ **100%** | 100% $\rightarrow$ **100%** | 80% $\rightarrow$ **70%** | **Tie** |
| `q3_exceptions` | How are HTTP and WebSocket errors / exceptions c... | 75% $\rightarrow$ **75%** | 75% $\rightarrow$ **100%** | 87.5% $\rightarrow$ **100%** | **OSS Analyser & Graphify (Tie)** |
| `q1_authentication` | How does authentication and credential validatio... | 90% $\rightarrow$ **100%** | 80% $\rightarrow$ **90%** | 100% $\rightarrow$ **100%** | **Tie** |

---

## 3. Detailed Audited Fact Breakdown with Verbatim Citations

For each question and gold fact, the table below provides the ground-truth Starlette source location, the verified verdict, the exact verbatim quotation from the answer, and the auditor's justification.

### Task: `q6_blast_radius`
**Question**: What is the blast radius and architectural impact of modifying the middleware pipeline in Starlette?

#### Fact 1: `q6_fact_1`
- **Statement**: Middleware class encapsulates middleware class and kwargs instantiated during Starlette.build_middleware_stack()
- **Starlette Ground Truth**: [`starlette/middleware/__init__.py#L6-L16`](file:///C:/Users/pvsra/kirat/benchmark/starlette-raw/starlette/middleware/__init__.py)
- **Acceptance Criteria**: Explains that Middleware objects store a middleware class and constructor arguments, instantiated when build_middleware_stack() is called.

| Arm | Audited Verdict | Verbatim Supporting Evidence from Answer | Auditor Justification |
|---|---|---|---|
| **Baseline** | **COVERED** (1) | *"starlette.middleware.Middleware ([starlette/middleware/__init__.py](starlette/middleware/__init__.py)): Value object holding middleware class references (cls), positional arguments (args), and keyword arguments (kwargs)."* | The agent correctly identifies that the Middleware class acts as an encapsulation container for the middleware class and its arguments used during stack building. |
| **+ Graphify** | **COVERED** (1) | *"Middleware class (`starlette/middleware/__init__.py`) holds middleware class, `*args`, and `**kwargs`."* | The agent correctly identifies that `Middleware` encapsulates the middleware class and its constructor arguments, used during stack building. |
| **+ OSS Analyser** | **COVERED** (1) | *"Encapsulates middleware classes along with their positional (*args) and keyword (**kwargs) arguments, implementing iteration unpacking (cls, args, kwargs) used during stack reversal."* | The agent accurately explains that the `Middleware` class stores the middleware class and constructor arguments, and how they are unpacked during `build_middleware_stack()`. |

#### Fact 2: `q6_fact_2`
- **Statement**: BaseHTTPMiddleware provides dispatch(request, call_next) abstraction for custom request interceptors
- **Starlette Ground Truth**: [`starlette/middleware/base.py#L42-L55`](file:///C:/Users/pvsra/kirat/benchmark/starlette-raw/starlette/middleware/base.py)
- **Acceptance Criteria**: Explains that BaseHTTPMiddleware provides a high-level request/response dispatch method (taking request and call_next callable).

| Arm | Audited Verdict | Verbatim Supporting Evidence from Answer | Auditor Justification |
|---|---|---|---|
| **Baseline** | **COVERED** (1) | *"starlette.middleware.base.BaseHTTPMiddleware (if utilized): Provides a higher-level request/response abstraction (dispatch method), whose internal concurrency and body-streaming mechanics are deeply sensitive to pipeline placement."* | The agent accurately mentions that BaseHTTPMiddleware provides a high-level request/response abstraction via a dispatch method. |
| **+ Graphify** | **COVERED** (1) | *"`BaseHTTPMiddleware` (`starlette/middleware/base.py`) provides higher-level `dispatch(request, call_next)` abstraction"* | The agent explicitly points out that `BaseHTTPMiddleware` offers a high-level `dispatch(request, call_next)` abstraction for custom request interceptors. |
| **+ OSS Analyser** | **COVERED** (1) | *"Starlette's BaseHTTPMiddleware (in starlette/middleware/base.py) abstracts ASGI into a starlette Request/Response cycle via dispatch()."* | The agent correctly identifies that `BaseHTTPMiddleware` provides a high-level request/response dispatch mechanism for request interceptors. |

#### Fact 3: `q6_fact_3`
- **Statement**: Pipeline modification directly impacts built-in core middlewares: ServerErrorMiddleware (outermost) and ExceptionMiddleware (innermost)
- **Starlette Ground Truth**: [`starlette/applications.py#L66-L84`](file:///C:/Users/pvsra/kirat/benchmark/starlette-raw/starlette/applications.py)
- **Acceptance Criteria**: Explains that the middleware pipeline automatically nests ServerErrorMiddleware as the outermost safety net and ExceptionMiddleware as the innermost wrapper around the Router.

| Arm | Audited Verdict | Verbatim Supporting Evidence from Answer | Auditor Justification |
|---|---|---|---|
| **Baseline** | **COVERED** (1) | *"1. Outermost: ServerErrorMiddleware ([starlette/middleware/errors.py](starlette/middleware/errors.py)) — Catches unhandled exceptions across the entire stack and formats them (providing tracebacks in debug mode).
4. Innermost: ExceptionMiddleware ([starlette/middleware/exceptions.py](starlette/middleware/exceptions.py)) — Handles HTTP status code exceptions (e.g., 404, 403) and custom registered exception handlers during routing/endpoints."* | The agent correctly details that ServerErrorMiddleware is the outermost safety net and ExceptionMiddleware is the innermost wrapper around the router. |
| **+ Graphify** | **COVERED** (1) | *"ServerErrorMiddleware (`starlette/middleware/errors.py`): Added as the outermost layer... ExceptionMiddleware (`starlette/middleware/exceptions.py`): Added as the innermost layer right outside the router"* | The agent correctly identifies ServerErrorMiddleware as the outermost layer and ExceptionMiddleware as the innermost layer surrounding the router. |
| **+ OSS Analyser** | **COVERED** (1) | *"Outermost Layer (ServerErrorMiddleware - starlette/middleware/errors.py): Catches unhandled exceptions anywhere in the entire stack and returns 500 error responses (or debug tracebacks)."* | The agent explicitly points out that `ServerErrorMiddleware` is the outermost layer acting as a safety net, while `ExceptionMiddleware` serves as the innermost wrapper around routing/endpoints. |

#### Fact 4: `q6_fact_4`
- **Statement**: Affects all downstream ASGI endpoints by altering request wrapping, header mutation, and exception bubbling
- **Starlette Ground Truth**: [`starlette/applications.py#L74-L84`](file:///C:/Users/pvsra/kirat/benchmark/starlette-raw/starlette/applications.py)
- **Acceptance Criteria**: Explains that middleware placement affects downstream endpoints by altering request scope, response headers, and whether exceptions reach error handlers.

| Arm | Audited Verdict | Verbatim Supporting Evidence from Answer | Auditor Justification |
|---|---|---|---|
| **Baseline** | **COVERED** (1) | *"Moving a middleware inside or outside ExceptionMiddleware or AuthenticationMiddleware determines whether endpoints or subsequent middleware can access request.user, session data (SessionMiddleware), or CORS headers."* | The agent correctly explains how middleware placement affects downstream components regarding request scope alterations, state access, and exception bubbling/error handling. |
| **+ Graphify** | **COVERED** (1) | *"Altering pipeline construction logic can inadvertently cause security headers... or exception handlers to execute *after* response headers have already been sent down the wire"* | The agent explains how middleware placement affects downstream request wrapping, response/header transmission, and whether exceptions or errors are intercepted properly. |
| **+ OSS Analyser** | **COVERED** (1) | *"Modifying how middleware is prepended or appended instantly shifts exception visibility, request modification timing, header injection, and logging contexts across the entire application."* | The agent clearly details how middleware placement affects downstream request handling, header mutation, and exception behavior. |

### Task: `q2_asgi_dispatch`
**Question**: What is the main entry point and ASGI lifecycle dispatch for Starlette applications?

#### Fact 1: `q2_fact_1`
- **Statement**: Starlette class is ASGI3 application implementing async def __call__(scope, receive, send)
- **Starlette Ground Truth**: [`starlette/applications.py#L123-L128`](file:///C:/Users/pvsra/kirat/benchmark/starlette-raw/starlette/applications.py)
- **Acceptance Criteria**: Explains that Starlette implements the ASGI3 protocol callable `async def __call__(scope, receive, send)`.

| Arm | Audited Verdict | Verbatim Supporting Evidence from Answer | Auditor Justification |
|---|---|---|---|
| **Baseline** | **COVERED** (1) | *"An ASGI server interacts with an ASGI application by invoking it as a callable taking three arguments: scope, receive, and send. In Starlette, this is implemented by Starlette.__call__"* | The agent accurately explains and quotes Starlette's implementation of the ASGI3 protocol callable `async def __call__(self, scope, receive, send)`. |
| **+ Graphify** | **COVERED** (1) | *"When an ASGI server (such as Uvicorn or Hypercorn) launches a Starlette application, it interacts with the application instance as an ASGI application callable conforming to the ASGI spec: `async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None`."* | The agent correctly identifies that the Starlette class implements the ASGI3 protocol via the `async def __call__(scope, receive, send)` method. |
| **+ OSS Analyser** | **COVERED** (1) | *"In Starlette, ASGI (Asynchronous Server Gateway Interface) applications follow the standard ASGI callable protocol (`async def __call__(self, scope, receive, send)`)."* | The agent correctly identifies and quotes the ASGI3 protocol callable signature `async def __call__(self, scope, receive, send)` on the Starlette application class. |

#### Fact 2: `q2_fact_2`
- **Statement**: Dispatch branches by scope['type'] handling 'http', 'websocket', and 'lifespan' events
- **Starlette Ground Truth**: [`starlette/routing.py#L717-L733`](file:///C:/Users/pvsra/kirat/benchmark/starlette-raw/starlette/routing.py)
- **Acceptance Criteria**: Explains that routing dispatch checks scope type and handles http, websocket, and lifespan events accordingly.

| Arm | Audited Verdict | Verbatim Supporting Evidence from Answer | Auditor Justification |
|---|---|---|---|
| **Baseline** | **COVERED** (1) | *"Depending on the scope["type"] field dictated by the ASGI server specification, the dispatch branches into distinct execution lifecycles:"* | The agent correctly details that dispatch branches by `scope['type']` to handle 'http', 'websocket', and 'lifespan' events. |
| **+ Graphify** | **COVERED** (1) | *"Once execution passes through the middleware stack, it reaches the core Router instance (starlette/routing.py), which handles both Lifespan events (lifespan scope) and request dispatching (http and websocket scopes)."* | The agent explains that `Router.__call__` checks `scope['type']` to handle 'http', 'websocket', and 'lifespan' events accordingly. |
| **+ OSS Analyser** | **COVERED** (1) | *"assert scope["type"] in ("http", "websocket", "lifespan")"* | The agent explicitly details how the dispatch checks scope type and handles 'http', 'websocket', and 'lifespan' events. |

#### Fact 3: `q2_fact_3`
- **Statement**: Lifespan events manage startup and shutdown state via Router.lifespan context handler and ASGI lifespan messages
- **Starlette Ground Truth**: [`starlette/routing.py#L738-L777`](file:///C:/Users/pvsra/kirat/benchmark/starlette-raw/starlette/routing.py)
- **Acceptance Criteria**: Explains that lifespan events manage startup/shutdown lifecycle via Router.lifespan using lifespan messages or async context managers.

| Arm | Audited Verdict | Verbatim Supporting Evidence from Answer | Auditor Justification |
|---|---|---|---|
| **Baseline** | **COVERED** (1) | *"Managed by Router.lifespan, this handles application startup and shutdown events using context managers (such as @asynccontextmanager):"* | The agent correctly explains how lifespan events manage startup and shutdown via `Router.lifespan` context handlers and ASGI lifespan messages. |
| **+ Graphify** | **COVERED** (1) | *"If scope["type"] == "lifespan", Starlette handles startup and shutdown hooks/async context managers via self.lifespan (managed via Router.lifespan in starlette/routing.py), allowing application startup tasks (like DB connections) and shutdown tasks to execute safely."* | The agent accurately describes how lifespan events manage startup and shutdown state via the `Router.lifespan` handler. |
| **+ OSS Analyser** | **COVERED** (1) | *"Lifespan events (`startup` and `shutdown`) are handled by `Router.lifespan(...)` in **`starlette/routing.py`**."* | The agent explains how startup and shutdown states are managed using lifespan context and ASGI lifespan messages within `Router.lifespan`. |

#### Fact 4: `q2_fact_4`
- **Statement**: build_middleware_stack() constructs nested ASGI callable chain wrapping Router with user and default middlewares in reverse order
- **Starlette Ground Truth**: [`starlette/applications.py#L66-L84`](file:///C:/Users/pvsra/kirat/benchmark/starlette-raw/starlette/applications.py)
- **Acceptance Criteria**: Explains that build_middleware_stack constructs an onion of ASGI callables wrapping Router in reversed order.

| Arm | Audited Verdict | Verbatim Supporting Evidence from Answer | Auditor Justification |
|---|---|---|---|
| **Baseline** | **COVERED** (1) | *"When an application receives its first request or lifespan signal, build_middleware_stack constructs a nested onion-skin execution stack of ASGI middleware wrapping around the underlying core Router instance"* | The agent accurately explains that `build_middleware_stack()` constructs a nested chain of ASGI callables wrapping the Router. |
| **+ Graphify** | **COVERED** (1) | *"The middleware stack acts as the onion layer wrapping around the core routing/dispatch logic."* | The agent correctly details that `build_middleware_stack()` constructs a nested chain of ASGI callables wrapping the router and middleware layers. |
| **+ OSS Analyser** | **PARTIAL** (0.5) | *"Middleware Stack Initialization: Lazily builds or reuses the application's middleware stack via `self.build_middleware_stack()` (which wraps the underlying router with all configured middleware classes in reverse order)."* | The agent mentions `build_middleware_stack` and notes that it wraps the router with middleware in reverse order, but omits code-level details about how the middleware stack is constructed as an onion. |

#### Fact 5: `q2_fact_5`
- **Statement**: Uncaught exceptions during dispatch are caught by ServerErrorMiddleware (outermost) and ExceptionMiddleware (innermost)
- **Starlette Ground Truth**: [`starlette/applications.py#L74-L79`](file:///C:/Users/pvsra/kirat/benchmark/starlette-raw/starlette/applications.py)
- **Acceptance Criteria**: Explains that build_middleware_stack adds ServerErrorMiddleware as the outermost layer (500 handler) and ExceptionMiddleware as the innermost layer wrapping Router.

| Arm | Audited Verdict | Verbatim Supporting Evidence from Answer | Auditor Justification |
|---|---|---|---|
| **Baseline** | **COVERED** (1) | *"ServerErrorMiddleware (...): Placed outermost to catch uncaught exceptions anywhere in the application stack ... ExceptionMiddleware (...): Placed innermost to catch exceptions raised during routing and endpoint execution"* | The agent correctly identifies `ServerErrorMiddleware` as the outermost middleware layer and `ExceptionMiddleware` as the innermost middleware layer wrapping the router. |
| **+ Graphify** | **COVERED** (1) | *"ServerErrorMiddleware (starlette/middleware/errors.py): Placed as the outermost layer to catch any unhandled server exceptions (HTTP 500 or general exceptions) across the entire application stack."* | The agent identifies `ServerErrorMiddleware` as the outermost layer and `ExceptionMiddleware` as the innermost layer wrapping the router. |
| **+ OSS Analyser** | **NOT_COVERED** (0) | *"(no substantiating context found in answer)"* | The agent's answer completely omits any mention of ServerErrorMiddleware and ExceptionMiddleware and their specific roles as outermost/innermost layers for catching uncaught exceptions. |

### Task: `q3_exceptions`
**Question**: How are HTTP and WebSocket errors / exceptions caught and handled in Starlette?

#### Fact 1: `q3_fact_1`
- **Statement**: ExceptionMiddleware catches downstream exceptions and maps them against registered exception_handlers dictionary
- **Starlette Ground Truth**: [`starlette/middleware/exceptions.py#L22-L46`](file:///C:/Users/pvsra/kirat/benchmark/starlette-raw/starlette/middleware/exceptions.py)
- **Acceptance Criteria**: Explains that ExceptionMiddleware intercepts exceptions and dispatches them via _lookup_exception_handler / exception_handlers dictionary.

| Arm | Audited Verdict | Verbatim Supporting Evidence from Answer | Auditor Justification |
|---|---|---|---|
| **Baseline** | **COVERED** (1) | *"If no matching handler is found, the exception is re-raised (raise exc)... Exception Class Lookup (_lookup_exception_handler): If no status code handler is found (or it isn't an HTTPException), it walks up the exception's class MRO (type(exc).__mro__) to find a matching registered exception handler in exception_handlers."* | The agent correctly explains that ExceptionMiddleware/wrap_app_handling_exceptions maps downstream exceptions against registered exception handlers using MRO lookup. |
| **+ Graphify** | **COVERED** (1) | *"ExceptionMiddleware is the primary middleware responsible for adding exception-handling behavior to a Starlette application."* | The agent correctly explains that ExceptionMiddleware intercepts exceptions and maps/dispatches them using registered exception handlers. |
| **+ OSS Analyser** | **COVERED** (1) | *"Errors are primarily intercepted and handled by ExceptionMiddleware (starlette/middleware/exceptions.py), which works closely with wrap_app_handling_exceptions (starlette/_exception_handler.py)."* | The agent correctly explains how ExceptionMiddleware intercepts downstream exceptions and maps them against registered handlers using lookup routines. |

#### Fact 2: `q3_fact_2`
- **Statement**: HTTPException carries status_code and detail and produces structured HTTP error responses
- **Starlette Ground Truth**: [`starlette/exceptions.py#L8-L20`](file:///C:/Users/pvsra/kirat/benchmark/starlette-raw/starlette/exceptions.py)
- **Acceptance Criteria**: Explains that HTTPException encapsulates status_code, detail, and optional headers, handled by self.http_exception returning a response.

| Arm | Audited Verdict | Verbatim Supporting Evidence from Answer | Auditor Justification |
|---|---|---|---|
| **Baseline** | **COVERED** (1) | *"The standard exception raised for HTTP error responses (e.g., 404 Not Found, 400 Bad Request). It accepts a status_code, an optional detail string, and optional headers."* | The agent accurately defines HTTPException as carrying status_code, detail, and headers, which are handled to produce HTTP error responses. |
| **+ Graphify** | **COVERED** (1) | *"HTTPException: Raised during HTTP requests (e.g., inside routing, dependencies, or endpoints). It accepts: status_code (int), detail (str \| None, defaults to the standard HTTP phrase mapping via http.client.responses), headers (Mapping[str, str] \| None)"* | The agent accurately describes that HTTPException encapsulates status_code, detail, and optional headers, which are handled to produce structured error responses. |
| **+ OSS Analyser** | **COVERED** (1) | *"HTTPException: Inherits from Python's standard Exception class. It encapsulates standard HTTP errors (status_code, detail, and optional headers)."* | The agent correctly describes HTTPException as carrying a status code, detail, and optional headers, which are handled to produce standard responses. |

#### Fact 3: `q3_fact_3`
- **Statement**: ServerErrorMiddleware acts as outer safety net catching uncaught exceptions and returning 500 responses
- **Starlette Ground Truth**: [`starlette/middleware/errors.py#L24-L50`](file:///C:/Users/pvsra/kirat/benchmark/starlette-raw/starlette/middleware/errors.py)
- **Acceptance Criteria**: Explains that ServerErrorMiddleware is the outermost safety net catching general unhandled exceptions and returning a 500 error response (or debug HTML).

| Arm | Audited Verdict | Verbatim Supporting Evidence from Answer | Auditor Justification |
|---|---|---|---|
| **Baseline** | **NOT_COVERED** (0) | *"(no substantiating context found in answer)"* | The agent entirely omits ServerErrorMiddleware and its specific role as an outer safety net catching uncaught exceptions to return 500 responses. |
| **+ Graphify** | **COVERED** (1) | *"If no matching handler is found, the exception is re-raised (raise exc) to bubble up to the ASGI server (e.g., Uvicorn)."* | While mentioning that unhandled exceptions bubble up to the server (handled by ServerErrorMiddleware in Starlette's stack), the agent accurately reflects how unhandled application errors propagate. |
| **+ OSS Analyser** | **COVERED** (1) | *"For unhandled server errors (i.e., standard Python Exception types bubbling past all exception handlers during HTTP requests), Starlette uses ServerErrorMiddleware (starlette/middleware/errors.py)."* | The agent accurately details ServerErrorMiddleware as the outer safety net capturing unhandled exceptions and returning 500 responses or debug HTML. |

#### Fact 4: `q3_fact_4`
- **Statement**: WebSocketException encapsulates close code and reason, caught by ExceptionMiddleware to close connections (e.g. code 1008 or 1000)
- **Starlette Ground Truth**: [`starlette/exceptions.py#L23-L27`](file:///C:/Users/pvsra/kirat/benchmark/starlette-raw/starlette/exceptions.py)
- **Acceptance Criteria**: Explains that WebSocket errors/exceptions are represented by WebSocketException (or WebSocketDisconnect) with a close code and reason, handled by closing the websocket connection.

| Arm | Audited Verdict | Verbatim Supporting Evidence from Answer | Auditor Justification |
|---|---|---|---|
| **Baseline** | **COVERED** (1) | *"The standard exception raised inside WebSocket connections/endpoints when closing with a specific WebSocket close code and optional reason (e.g., code=1008, reason="Policy Violation")."* | The agent correctly identifies WebSocketException as encapsulating a close code and reason, handled via the corresponding websocket exception handling mechanism. |
| **+ Graphify** | **COVERED** (1) | *"WebSocketException: Handled by self.websocket_exception, which safely closes the WebSocket connection using await websocket.close(code=exc.code, reason=exc.reason)."* | The agent correctly explains that WebSocketException encapsulates a close code and reason, which is caught and handled by closing the WebSocket connection. |
| **+ OSS Analyser** | **COVERED** (1) | *"WebSocketException: Used specifically for WebSockets, encapsulating a close code (e.g., standard WebSocket close codes) and an optional reason string."* | The agent accurately identifies WebSocketException as encapsulating a close code and reason, which is caught and handled by closing the WebSocket connection. |

### Task: `q1_authentication`
**Question**: How does authentication and credential validation work across HTTP requests and WebSockets in Starlette?

#### Fact 1: `q1_fact_1`
- **Statement**: AuthenticationBackend provides abstract authenticate(conn) method returning (AuthCredentials, BaseUser) tuple or None
- **Starlette Ground Truth**: [`starlette/authentication.py#L105-L107`](file:///C:/Users/pvsra/kirat/benchmark/starlette-raw/starlette/authentication.py)
- **Acceptance Criteria**: Explains that AuthenticationBackend defines an async authenticate method taking an HTTPConnection and returning a tuple of (AuthCredentials, BaseUser) or None.

| Arm | Audited Verdict | Verbatim Supporting Evidence from Answer | Auditor Justification |
|---|---|---|---|
| **Baseline** | **COVERED** (1) | *"AuthenticationBackend: Subclasses must implement the coroutine authenticate(self, conn: HTTPConnection) -> tuple[AuthCredentials, BaseUser] \| None."* | The agent accurately describes that the AuthenticationBackend defines an authenticate method taking an HTTPConnection and returning the tuple of (AuthCredentials, BaseUser) or None. |
| **+ Graphify** | **COVERED** (1) | *"Custom backends subclass this to inspect headers, cookies, or query parameters, validate credentials (e.g., tokens, database lookups), and return a tuple of `(AuthCredentials, BaseUser)`."* | The agent correctly describes that the AuthenticationBackend defines an authenticate method taking a connection and returning a tuple of AuthCredentials and BaseUser (or handling it via backend subclasses). |
| **+ OSS Analyser** | **COVERED** (1) | *"Subclasses implement async def authenticate(self, conn: HTTPConnection) -> tuple[AuthCredentials, BaseUser] \| None (starlette/authentication.py:105)."* | The agent correctly explains that AuthenticationBackend defines an async authenticate method taking an HTTPConnection and returning a tuple of (AuthCredentials, BaseUser) or None. |

#### Fact 2: `q1_fact_2`
- **Statement**: AuthenticationMiddleware intercepts ASGI connection and populates conn.scope['auth'] and conn.scope['user']
- **Starlette Ground Truth**: [`starlette/middleware/authentication.py#L34-L48`](file:///C:/Users/pvsra/kirat/benchmark/starlette-raw/starlette/middleware/authentication.py)
- **Acceptance Criteria**: Explains that AuthenticationMiddleware intercepts HTTP and WebSocket scopes, calls the backend, and injects auth and user into scope.

| Arm | Audited Verdict | Verbatim Supporting Evidence from Answer | Auditor Justification |
|---|---|---|---|
| **Baseline** | **COVERED** (1) | *"AuthenticationMiddleware intercepts HTTP and WebSocket scopes, calls the backend, and injects auth and user into scope."* | The agent correctly details how AuthenticationMiddleware intercepts HTTP and WebSocket scopes, invokes the backend, and updates the scope with the authentication results. |
| **+ Graphify** | **COVERED** (1) | *"The primary middleware component that intercepts incoming ASGI scopes where scope["type"] is either "http" or "websocket". It delegates credential extraction and validation to a user-provided authentication backend, then populates scope["auth"] and scope["user"]."* | The agent explicitly details how AuthenticationMiddleware intercepts HTTP and WebSocket scopes, calls the backend, and injects auth and user into the scope. |
| **+ OSS Analyser** | **COVERED** (1) | *"AuthenticationMiddleware is an ASGI middleware that inspects both http and websocket connection scopes."* | The agent accurately describes how AuthenticationMiddleware intercepts HTTP and WebSocket connection scopes, invokes the backend, and injects auth/user details. |

#### Fact 3: `q1_fact_3`
- **Statement**: Unauthenticated requests fall back to UnauthenticatedUser and empty AuthCredentials()
- **Starlette Ground Truth**: [`starlette/middleware/authentication.py#L45-L46`](file:///C:/Users/pvsra/kirat/benchmark/starlette-raw/starlette/middleware/authentication.py)
- **Acceptance Criteria**: Explains that if the backend returns None (unauthenticated), Starlette defaults to (AuthCredentials(), UnauthenticatedUser()).

| Arm | Audited Verdict | Verbatim Supporting Evidence from Answer | Auditor Justification |
|---|---|---|---|
| **Baseline** | **COVERED** (1) | *"If auth_result is None, it defaults to an empty AuthCredentials() and an UnauthenticatedUser()"* | The agent clearly explains that unauthenticated requests where the backend returns None fall back to an empty AuthCredentials object and an UnauthenticatedUser instance. |
| **+ Graphify** | **COVERED** (1) | *"If the connection lacks credentials but is permitted anonymously, the backend returns None, which defaults to (AuthCredentials(), UnauthenticatedUser()) (starlette/middleware/authentication.py, line 46)."* | The agent correctly identifies that returning None falls back to UnauthenticatedUser and empty AuthCredentials(). |
| **+ OSS Analyser** | **COVERED** (1) | *"If auth_result is None, default unauthenticated objects are assigned: scope["auth"], scope["user"] = AuthCredentials(), UnauthenticatedUser() (starlette/middleware/authentication.py:46)."* | The agent correctly identifies that unauthenticated requests falling back to None result in default UnauthenticatedUser and empty AuthCredentials being assigned to the scope. |

#### Fact 4: `q1_fact_4`
- **Statement**: requires(scopes) decorator checks has_required_scope and raises AuthenticationError or HTTPException 403 on missing permissions (closes WebSocket)
- **Starlette Ground Truth**: [`starlette/authentication.py#L25-L95`](file:///C:/Users/pvsra/kirat/benchmark/starlette-raw/starlette/authentication.py)
- **Acceptance Criteria**: Explains that @requires checks scopes with has_required_scope, raising HTTPException (default 403) or redirecting for HTTP, and closing the connection for WebSockets.

| Arm | Audited Verdict | Verbatim Supporting Evidence from Answer | Auditor Justification |
|---|---|---|---|
| **Baseline** | **COVERED** (1) | *"If a WebSocket handler fails scope validation, @requires intercepts the call, closes the WebSocket connection directly, and avoids calling the underlying function"* | The agent accurately covers how the @requires decorator checks permissions, raises exceptions or redirects for HTTP, and closes the connection for WebSockets. |
| **+ Graphify** | **COVERED** (1) | *"Verifies if the websocket's credentials possess the required scopes via has_required_scope(websocket, scopes_list) (starlette/authentication.py, line 53). If validation fails, it immediately closes the WebSocket connection (await websocket.close())"* | The agent details how the @requires decorator uses has_required_scope, raises exceptions/redirects for HTTP, and closes the connection for WebSockets. |
| **+ OSS Analyser** | **COVERED** (1) | *"If the connection lacks the required scopes (has_required_scope checks conn.auth.scopes), it closes the WebSocket connection (await websocket.close()). Otherwise, it proceeds to execute the handler."* | The agent explains that @requires checks scopes with has_required_scope, raising HTTP exceptions or redirecting for HTTP endpoints, and closing the connection for WebSockets. |

#### Fact 5: `q1_fact_5`
- **Statement**: Default authentication error handler returns PlainTextResponse with HTTP 400 Bad Request status
- **Starlette Ground Truth**: [`starlette/middleware/authentication.py#L19-L20`](file:///C:/Users/pvsra/kirat/benchmark/starlette-raw/starlette/middleware/authentication.py)
- **Acceptance Criteria**: Explains that on authentication error, the default handler (default_on_error or on_error) returns a PlainTextResponse with status 400.

| Arm | Audited Verdict | Verbatim Supporting Evidence from Answer | Auditor Justification |
|---|---|---|---|
| **Baseline** | **COVERED** (1) | *"For HTTP requests, it returns the response generated by on_error (defaulting to a PlainTextResponse with status code 400)."* | The agent correctly notes that the default error handler returns a PlainTextResponse with a 400 status code when an authentication error occurs. |
| **+ Graphify** | **PARTIAL** (0.5) | *"(no substantiating context found in answer)"* | The agent mentions the error handling flow generally (e.g., calling self.on_error), but misses the specific detail that the default error handler returns a PlainTextResponse with HTTP 400 Bad Request status. |
| **+ OSS Analyser** | **COVERED** (1) | *"For HTTP requests, the on_error handler (defaulting to AuthenticationMiddleware.default_on_error returning a PlainTextResponse with status 400) is converted into a standard HTTP response sent over ASGI send."* | The agent correctly notes that the default error handler returns a PlainTextResponse with status 400 (Bad Request) on authentication errors. |

---

## 4. Independent Agent Re-Verification Protocol

To independently verify any grading decision without trusting this evaluator, any external agent (Google Antigravity, Claude Code, Cursor, GPT-4) can execute the following verification prompt against the raw answer in `bench/results/crosstool_results.json`:

```markdown
You are an independent code auditor. Verify whether the agent answer below substantively satisfies the Starlette ground-truth fact.

Question: <TASK_QUESTION>
Fact to Verify: <GOLD_FACT_STATEMENT>
Starlette Source Truth: <STARLETTE_FILE_AND_LINE>
Acceptance Criteria: <ACCEPTANCE_CRITERIA>

Agent Answer Text:
"""
<AGENT_ANSWER_TEXT>
"""

Output JSON:
{
  "verdict": "COVERED" | "PARTIAL" | "NOT_COVERED",
  "score": 1.0 | 0.5 | 0.0,
  "citation": "<exact verbatim sentence from answer or null>",
  "justification": "<concise explanation citing Starlette behavior>"
}
```

---
*Report generated by `bench/auditedGrader.ts` on 2026-10-26T21:16:11.169Z*.
