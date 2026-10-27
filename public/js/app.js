let currentRepoId = localStorage.getItem("oss_active_repo") || "";
let currentThreadId = localStorage.getItem("oss_active_thread") || null;
let currentView = "chat"; // "chat" | "graph"
let repositoriesData = [];
let threadsCache = new Map(); // repoId -> threads array
const collapsedProjects = new Set(); // tracks collapsed project cards in sidebar
let cy = null;

// Helper to get auth headers with saved Supabase token
function getAuthHeaders() {
  const token = localStorage.getItem("oss_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatMarkdown(text) {
  if (!text) return "";
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // Code blocks
    .replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (match, lang, code) => {
      return `<div class="chat-code-block"><div class="chat-code-lang">${lang || "code"}</div><pre><code>${code.trim()}</code></pre></div>`;
    })
    // Inline code
    .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
    // Headings
    .replace(/^### (.*$)/gim, '<h4 style="color: #93c5fd; margin: 10px 0 4px; font-size: 0.95rem;">$1</h4>')
    .replace(/^## (.*$)/gim, '<h3 style="color: #60a5fa; margin: 12px 0 6px; font-size: 1.05rem;">$1</h3>')
    .replace(/^# (.*$)/gim, '<h2 style="color: #3b82f6; margin: 14px 0 8px; font-size: 1.15rem;">$1</h2>')
    // Bold
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    // Italic
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    // Bullet lists
    .replace(/^\s*[\*\-]\s+(.*$)/gim, '<div style="display: flex; gap: 6px; margin: 3px 0 3px 12px;"><span style="color: var(--primary);">•</span><span>$1</span></div>')
    // Convert newlines to br
    .replace(/\n/g, '<br/>');
  return html;
}

// -----------------------------------------------------------------------------
// Repository Selection & Ingestion
// -----------------------------------------------------------------------------

async function loadRepositoriesList() {
  try {
    const res = await fetch("/api/repos", {
      headers: getAuthHeaders()
    });

    if (!res.ok) {
      repositoriesData = [];
      renderSidebarProjects();
      return;
    }

    const repos = await res.json();
    repositoriesData = Array.isArray(repos) ? repos : [];

    if (repositoriesData.length === 0) {
      currentRepoId = "";
      renderSidebarProjects();
      showEmptyState(true);
      return;
    }

    // Default to the first repo if active repo is invalid
    if (!currentRepoId || !repositoriesData.some((r) => r.id === currentRepoId)) {
      currentRepoId = repositoriesData[0].id;
    }

    localStorage.setItem("oss_active_repo", currentRepoId);
    renderSidebarProjects();
    updateRepoStatusUI();

    // Auto-fetch threads for all repos so chats appear beneath every project
    await Promise.all(repositoriesData.map((r) => fetchThreadsForRepo(r.id)));
  } catch (err) {
    console.error("Failed to load repositories:", err);
    repositoriesData = [];
    renderSidebarProjects();
  }
}

function toggleProjectCollapse(repoId) {
  if (collapsedProjects.has(repoId)) {
    collapsedProjects.delete(repoId);
  } else {
    collapsedProjects.add(repoId);
  }
  const chatsList = document.getElementById(`project-chats-${repoId}`);
  const icon = document.getElementById(`toggle-icon-${repoId}`);
  if (chatsList) {
    chatsList.style.display = collapsedProjects.has(repoId) ? "none" : "flex";
  }
  if (icon) {
    icon.className = collapsedProjects.has(repoId)
      ? "fa-solid fa-chevron-right project-toggle-icon"
      : "fa-solid fa-chevron-down project-toggle-icon";
  }
}

function renderSidebarProjects() {
  const container = document.getElementById("projects-sidebar-list");
  if (!container) return;

  if (repositoriesData.length === 0) {
    container.innerHTML = `
      <div style="padding: 18px 12px; color: var(--text-muted); font-size: 0.8rem; text-align: center;">
        <i class="fa-solid fa-folder-open" style="font-size: 1.5rem; margin-bottom: 8px; display: block; opacity: 0.5;"></i>
        No repositories indexed.<br/>Click <b>Ingest Repository</b> above.
      </div>
    `;
    updateChatHeader();
    return;
  }

  container.innerHTML = repositoriesData
    .map((r) => {
      const isActive = r.id === currentRepoId;
      const isCollapsed = collapsedProjects.has(r.id);
      const statusIcon = r.status === "completed" ? "✓" : r.status === "parsed" ? "⏳" : "●";
      const cached = threadsCache.get(r.id);
      let threadsHtml = `<div style="color: var(--text-muted); font-size: 0.72rem; padding: 4px 6px;">Loading chats...</div>`;
      if (cached) {
        if (cached.length === 0) {
          threadsHtml = `<div style="color: var(--text-muted); font-size: 0.72rem; padding: 4px 6px; font-style: italic;">No chats yet. Click New Chat above.</div>`;
        } else {
          threadsHtml = cached
            .map(
              (t) => `
            <div class="chat-thread-item ${t.id === currentThreadId ? "active" : ""}" data-thread-id="${t.id}" onclick="selectThread('${t.id}', '${r.id}')">
              <span class="thread-item-title" title="${escapeHtml(t.title)}">
                <i class="fa-regular fa-message"></i> ${escapeHtml(t.title)}
              </span>
              <button class="btn-delete-thread" onclick="event.stopPropagation(); deleteThread('${t.id}', '${r.id}')" title="Delete conversation">
                <i class="fa-solid fa-xmark"></i>
              </button>
            </div>
          `
            )
            .join("");
        }
      }

      return `
        <div class="project-card ${isActive ? "active" : ""}" id="project-card-${r.id}">
          <div class="project-header" onclick="selectProject('${r.id}')">
            <div class="project-title-area">
              <i class="fa-solid ${isCollapsed ? "fa-chevron-right" : "fa-chevron-down"} project-toggle-icon" id="toggle-icon-${r.id}" onclick="event.stopPropagation(); toggleProjectCollapse('${r.id}')" title="Toggle chats list"></i>
              <i class="fa-solid fa-folder-tree project-icon"></i>
              <span class="project-name" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</span>
              <span class="badge" style="font-size: 0.65rem; padding: 1px 5px;">${statusIcon}</span>
            </div>
            <div class="project-actions" onclick="event.stopPropagation()">
              <button class="btn-sidebar-action btn-view-graph" onclick="viewGraphForRepo('${r.id}')" title="View Code Graph">
                <i class="fa-solid fa-circle-nodes"></i> Graph
              </button>
              <button class="btn-sidebar-action btn-delete-repo" onclick="openDeleteModal('${r.id}')" title="Delete Repository">
                <i class="fa-solid fa-trash-can"></i>
              </button>
            </div>
          </div>

          <!-- Nested Chats Container (displayed directly beneath project!) -->
          <div class="project-chats-list" id="project-chats-${r.id}" style="${isCollapsed ? "display: none;" : "display: flex;"}">
            <button class="btn-new-chat" onclick="startNewChatForRepo('${r.id}')">
              <i class="fa-solid fa-plus"></i> New Chat
            </button>
            <div class="threads-sublist" id="threads-sublist-${r.id}">
              ${threadsHtml}
            </div>
          </div>
        </div>
      `;
    })
    .join("");

  updateChatHeader();
}

async function selectProject(repoId) {
  currentRepoId = repoId;
  localStorage.setItem("oss_active_repo", currentRepoId);

  // If collapsed, expand it
  collapsedProjects.delete(repoId);
  const chatsList = document.getElementById(`project-chats-${repoId}`);
  const icon = document.getElementById(`toggle-icon-${repoId}`);
  if (chatsList) chatsList.style.display = "flex";
  if (icon) icon.className = "fa-solid fa-chevron-down project-toggle-icon";

  document.querySelectorAll(".project-card").forEach((el) => {
    el.classList.toggle("active", el.id === `project-card-${repoId}`);
  });

  updateRepoStatusUI();
  updateChatHeader();

  const cached = threadsCache.get(repoId);
  if (cached && cached.length > 0) {
    if (!currentThreadId || !cached.some((t) => t.id === currentThreadId)) {
      await selectThread(cached[0].id, repoId);
    }
  } else {
    await fetchThreadsForRepo(repoId);
  }
}

async function fetchThreadsForRepo(repoId) {
  const container = document.getElementById(`threads-sublist-${repoId}`);
  try {
    const res = await fetch(`/api/repos/${repoId}/threads`, {
      headers: getAuthHeaders()
    });
    if (!res.ok) throw new Error("Failed to load threads");
    const threads = await res.json();
    threadsCache.set(repoId, threads);

    if (container) {
      if (threads.length === 0) {
        container.innerHTML = `<div style="color: var(--text-muted); font-size: 0.72rem; padding: 4px 6px; font-style: italic;">No chats yet. Click New Chat above.</div>`;
      } else {
        container.innerHTML = threads
          .map(
            (t) => `
          <div class="chat-thread-item ${t.id === currentThreadId ? "active" : ""}" data-thread-id="${t.id}" onclick="selectThread('${t.id}', '${repoId}')">
            <span class="thread-item-title" title="${escapeHtml(t.title)}">
              <i class="fa-regular fa-message"></i> ${escapeHtml(t.title)}
            </span>
            <button class="btn-delete-thread" onclick="event.stopPropagation(); deleteThread('${t.id}', '${repoId}')" title="Delete conversation">
              <i class="fa-solid fa-xmark"></i>
            </button>
          </div>
        `
          )
          .join("");
      }
    }

    // Auto-select first thread if currentRepoId matches and no active thread
    if (repoId === currentRepoId) {
      if (!currentThreadId || !threads.some((t) => t.id === currentThreadId)) {
        if (threads.length > 0) {
          await selectThread(threads[0].id, repoId);
        } else {
          currentThreadId = null;
          renderWelcomeEmptyState();
        }
      }
    }
  } catch (err) {
    console.error("Error loading threads for repo:", err);
    if (container) {
      container.innerHTML = `<div style="color: var(--text-muted); font-size: 0.72rem; padding: 4px;">Offline or error</div>`;
    }
  }
}

async function startNewChatForRepo(repoId) {
  currentRepoId = repoId;
  localStorage.setItem("oss_active_repo", repoId);
  switchToChatView();

  try {
    const res = await fetch(`/api/repos/${repoId}/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: JSON.stringify({ title: "New Conversation" })
    });
    if (!res.ok) throw new Error("Failed to create thread");
    const newThread = await res.json();
    currentThreadId = newThread.id;
    localStorage.setItem("oss_active_thread", currentThreadId);

    // Refresh threads and render empty state
    await fetchThreadsForRepo(repoId);
    renderWelcomeEmptyState();
    const input = document.getElementById("chat-input");
    if (input) input.focus();
  } catch (err) {
    console.error("Failed to start new chat:", err);
  }
}

async function selectThread(threadId, repoId) {
  currentRepoId = repoId;
  currentThreadId = threadId;
  localStorage.setItem("oss_active_repo", repoId);
  localStorage.setItem("oss_active_thread", threadId);
  switchToChatView();

  // Highlight active thread item in sidebar and parent project card
  document.querySelectorAll(".project-card").forEach((el) => {
    el.classList.toggle("active", el.id === `project-card-${repoId}`);
  });
  document.querySelectorAll(".chat-thread-item").forEach((el) => {
    el.classList.toggle("active", el.getAttribute("data-thread-id") === threadId);
  });

  const chatBox = document.getElementById("chat-messages");
  if (chatBox) {
    chatBox.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 40px;"><i class="fa-solid fa-spinner fa-spin"></i> Loading conversation...</div>`;
  }

  try {
    const res = await fetch(`/api/repos/${repoId}/threads/${threadId}/messages`, {
      headers: getAuthHeaders()
    });
    if (!res.ok) throw new Error("Failed to load messages");
    const data = await res.json();

    updateChatHeader(data.thread?.title);

    if (!data.messages || data.messages.length === 0) {
      renderWelcomeEmptyState();
      return;
    }

    if (chatBox) {
      chatBox.innerHTML = data.messages
        .map((m) => renderMessageHtml(m.role, m.content, m.referenced_nodes, m.blast_radius))
        .join("");
      const container = document.getElementById("chat-feed-container");
      if (container) container.scrollTop = container.scrollHeight;
    }
  } catch (err) {
    console.error("Failed to load thread messages:", err);
    if (chatBox) {
      chatBox.innerHTML = `<div style="text-align: center; color: var(--danger); padding: 40px;">Failed to load messages: ${err.message}</div>`;
    }
  }
}

async function deleteThread(threadId, repoId) {
  if (!confirm("Are you sure you want to delete this conversation?")) return;
  try {
    await fetch(`/api/repos/${repoId}/threads/${threadId}`, {
      method: "DELETE",
      headers: getAuthHeaders()
    });
    if (currentThreadId === threadId) {
      currentThreadId = null;
      localStorage.removeItem("oss_active_thread");
    }
    await fetchThreadsForRepo(repoId);
  } catch (err) {
    console.error("Failed to delete thread:", err);
  }
}

function updateChatHeader(threadTitle) {
  const repoBadge = document.getElementById("chat-repo-name");
  const titleEl = document.getElementById("chat-thread-title");
  const btnGraph = document.getElementById("btn-chat-view-graph");
  const btnSumm = document.getElementById("btn-chat-summarize");

  const repo = repositoriesData.find((r) => r.id === currentRepoId);
  if (repoBadge) {
    repoBadge.textContent = repo ? repo.name : "No Project Selected";
  }
  if (titleEl) {
    titleEl.textContent = threadTitle || (repo ? "New Conversation" : "Select or ingest a project");
  }
  if (btnGraph) {
    btnGraph.style.display = repo ? "inline-flex" : "none";
  }
  if (btnSumm) {
    btnSumm.style.display = repo && !isHostedDemoServer ? "inline-flex" : "none";
  }
}

function renderWelcomeEmptyState() {
  const chatBox = document.getElementById("chat-messages");
  if (!chatBox) return;

  const repo = repositoriesData.find((r) => r.id === currentRepoId);
  if (!repo) {
    chatBox.innerHTML = `
      <div class="chat-welcome-state">
        <div class="welcome-icon"><i class="fa-solid fa-comments"></i></div>
        <h3>Codebase Q&A Copilot</h3>
        <p>Select a project from the left sidebar to start chatting about its architecture, functions, and blast radius impact.</p>
      </div>
    `;
    return;
  }

  if (isHostedDemoServer) {
    chatBox.innerHTML = `
      <div class="chat-welcome-state">
        <div class="welcome-icon"><i class="fa-solid fa-diagram-project" style="color: var(--primary);"></i></div>
        <h3>${escapeHtml(repo.name)} Architecture Explorer</h3>
        <p style="margin-bottom: 16px;">This repository is fully indexed with hierarchical AST code graphs, symbol signatures, and transitive blast radius impact calculations.</p>
        <div style="background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.3); border-radius: 8px; padding: 12px 16px; margin: 0 auto 16px; max-width: 520px; font-size: 0.85rem; color: #93c5fd; text-align: left;">
          <div style="font-weight: 600; margin-bottom: 4px;"><i class="fa-solid fa-circle-info"></i> Public Demo Mode</div>
          AI Copilot queries and summarization are paused on this hosted demo to protect API quota. You have full interactive access to explore the code graph!
        </div>
        <div style="display: flex; gap: 8px; justify-content: center;">
          <button class="btn btn-primary" onclick="switchToGraphView()">
            <i class="fa-solid fa-circle-nodes"></i> Explore Interactive Code Graph
          </button>
        </div>
      </div>
    `;
    return;
  }

  chatBox.innerHTML = `
    <div class="chat-welcome-state">
      <div class="welcome-icon"><i class="fa-solid fa-code-branch"></i></div>
      <h3>Welcome to ${escapeHtml(repo.name)}</h3>
      <p style="margin-bottom: 16px;">Ask anything about this codebase. Graph-augmented RAG retrieves full code implementations, Git ownership, and blast radius dependencies.</p>
      <div style="display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; max-width: 540px; margin: 0 auto;">
        <button class="btn btn-secondary btn-sm" onclick="askQuickPrompt('What does this repository do and what is its architecture?')">
          💡 What does this repository do?
        </button>
        <button class="btn btn-secondary btn-sm" onclick="askQuickPrompt('Where is the entry point and how does initialization work?')">
          🚀 Where is the entry point?
        </button>
        <button class="btn btn-secondary btn-sm" onclick="askQuickPrompt('What are the key storage and persistence components?')">
          💾 How is storage handled?
        </button>
      </div>
    </div>
  `;
}

function askQuickPrompt(promptText) {
  const input = document.getElementById("chat-input");
  if (input) {
    input.value = promptText;
    sendChat();
  }
}

function updateRepoStatusUI() {
  const graphHeading = document.getElementById("graph-repo-heading");
  const repo = repositoriesData.find((r) => r.id === currentRepoId);
  if (graphHeading) {
    graphHeading.textContent = repo ? `${repo.name} (${repo.id})` : "No Repository Selected";
  }
}

function switchView(viewName) {
  currentView = viewName;
  const viewChat = document.getElementById("view-chat");
  const viewGraph = document.getElementById("view-graph");

  if (viewName === "chat") {
    if (viewChat) viewChat.classList.add("active");
    if (viewGraph) viewGraph.classList.remove("active");
  } else {
    if (viewGraph) viewGraph.classList.add("active");
    if (viewChat) viewChat.classList.remove("active");
    if (cy) {
      cy.resize();
      cy.fit();
    }
  }
}

function switchToChatView() {
  switchView("chat");
}

function switchToGraphView() {
  switchView("graph");
  loadGraph();
}

async function viewGraphForRepo(repoId) {
  currentRepoId = repoId;
  localStorage.setItem("oss_active_repo", repoId);
  renderSidebarProjects();
  updateRepoStatusUI();
  switchView("graph");
  await loadGraph();
}

async function selectNodeInGraph(nodeId) {
  switchToGraphView();
  if (!cy || cy.elements().length === 0) {
    await loadGraph();
  }
  selectNode(nodeId);
}

function toggleSidebar() {
  const sidebar = document.getElementById("sidebar");
  if (sidebar) sidebar.classList.toggle("open");
}

function handleChatKeydown(event) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendChat();
  }
}

function showEmptyState(show) {
  const overlay = document.getElementById("graph-empty-state");
  if (overlay) {
    overlay.style.display = show ? "block" : "none";
  }
}

// -----------------------------------------------------------------------------
// Cytoscape Dependency Graph Explorer
// -----------------------------------------------------------------------------

async function loadGraph() {
  if (!currentRepoId) {
    showEmptyState(true);
    return;
  }

  try {
    const res = await fetch(`/api/repos/${currentRepoId}/graph`, {
      headers: getAuthHeaders()
    });

    if (!res.ok) {
      showEmptyState(true);
      return;
    }

    const graph = await res.json();

    if (!graph.nodes || graph.nodes.length === 0) {
      showEmptyState(true);
      return;
    }

    showEmptyState(false);

    const elements = [
      ...graph.nodes.map((n) => ({
        data: {
          ...n.data,
          color:
            n.data.nodeType === "function"
              ? "#3b82f6"
              : n.data.nodeType === "file"
              ? "#10b981"
              : "#f59e0b"
        }
      })),
      ...graph.edges
    ];

    cy = cytoscape({
      container: document.getElementById("cy"),
      elements,
      style: [
        {
          selector: "node",
          style: {
            label: "data(label)",
            "font-size": 11,
            "text-wrap": "wrap",
            "text-max-width": 120,
            "background-color": "data(color)",
            color: "#f8fafc",
            "text-valign": "bottom",
            "text-margin-y": 6,
            "border-width": 2,
            "border-color": "#1e293b"
          }
        },
        {
          selector: "node:selected",
          style: {
            "border-width": 4,
            "border-color": "#ffffff",
            "background-color": "#60a5fa"
          }
        },
        {
          selector: "edge",
          style: {
            width: 2,
            "line-color": "#475569",
            "target-arrow-color": "#475569",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            label: "data(label)",
            "font-size": 8,
            color: "#94a3b8",
            "text-rotation": "autorotate"
          }
        },
        {
          selector: ".highlight-blast",
          style: {
            "background-color": "#ef4444 !important",
            "border-color": "#fca5a5 !important",
            "border-width": 3
          }
        },
        {
          selector: ".highlight-search",
          style: {
            "border-color": "#38bdf8 !important",
            "border-width": 4,
            "background-color": "#0284c7 !important"
          }
        }
      ],
      layout: {
        name: "cose",
        animate: false,
        padding: 40
      }
    });

    cy.on("tap", "node", async (evt) => {
      const node = evt.target;
      selectNode(node.data("id"));
    });
  } catch (err) {
    console.error("Failed to load graph:", err);
    showEmptyState(true);
  }
}

// -----------------------------------------------------------------------------
// Node Search & Filter
// -----------------------------------------------------------------------------

function onNodeSearch(query) {
  if (!cy) return;
  const q = (query || "").trim().toLowerCase();

  cy.elements().removeClass("highlight-search");

  if (!q) return;

  const matches = cy.nodes().filter((node) => {
    const label = (node.data("label") || "").toLowerCase();
    const id = (node.data("id") || "").toLowerCase();
    return label.includes(q) || id.includes(q);
  });

  if (matches.length > 0) {
    matches.addClass("highlight-search");
    cy.animate({
      center: { eles: matches.first() },
      zoom: 1.2,
      duration: 300
    });
  }
}

// -----------------------------------------------------------------------------
// Node Inspector Details
// -----------------------------------------------------------------------------

function resetInspector() {
  const placeholder = document.getElementById("inspector-placeholder");
  const details = document.getElementById("inspector-details");
  if (placeholder) placeholder.style.display = "block";
  if (details) details.style.display = "none";
}

async function selectNode(nodeId) {
  if (!cy || !currentRepoId) return;

  switchTab("inspector");
  document.getElementById("inspector-placeholder").style.display = "none";
  document.getElementById("inspector-details").style.display = "block";

  // Center on node in graph
  const targetNode = cy.$(`#${nodeId}`);
  if (targetNode.length > 0) {
    cy.nodes().unselect();
    targetNode.select();
    cy.animate({
      center: { eles: targetNode },
      duration: 300
    });
  }

  try {
    const res = await fetch(`/api/repos/${currentRepoId}/nodes/${nodeId}`, {
      headers: getAuthHeaders()
    });

    if (!res.ok) {
      console.warn("Failed to fetch node details:", res.statusText);
      return;
    }

    const data = await res.json();

    document.getElementById("node-name").innerText = data.node.name;
    const locText = data.node.startLine
      ? ` (Line ${data.node.startLine}${data.node.startColumn ? `:${data.node.startColumn}` : ""}${
          data.node.endLine ? `–${data.node.endLine}${data.node.endColumn ? `:${data.node.endColumn}` : ""}` : ""
        })`
      : "";
    document.getElementById("node-file").innerText = `${data.node.filePath}${locText}`;
    document.getElementById("node-summary").innerText = data.node.summary;
    document.getElementById("node-code").innerText = data.node.rawCode || "// No raw code snippet available";

    // Ownership Breakdown
    const ownerEl = document.getElementById("node-ownership");
    ownerEl.innerHTML = "";
    if (data.ownership && data.ownership.length > 0) {
      data.ownership.forEach((o) => {
        ownerEl.innerHTML += `
          <div class="ownership-item">
            <span><b>${o.authorName}</b> (${o.authorEmail})</span>
            <span>${o.ownershipPercentage}% (${o.linesAuthored} lines, ${o.totalCommits || 1} commits)</span>
          </div>
          <div class="ownership-bar"><div class="ownership-fill" style="width: ${o.ownershipPercentage}%"></div></div>
        `;
      });
    } else {
      ownerEl.innerHTML = "<p style='color: var(--text-muted); font-size: 0.82rem;'>No git blame records available for this range.</p>";
    }

    // Blast Radius Impact
    const blastEl = document.getElementById("node-blast-radius");
    blastEl.innerHTML = "";
    cy.elements().removeClass("highlight-blast");

    if (data.blastRadius && data.blastRadius.length > 0) {
      data.blastRadius.forEach((b) => {
        blastEl.innerHTML += `
          <div class="blast-item" style="cursor: pointer;" onclick="selectNode('${b.id}')">
            <span>💥 <b>${b.name}</b> (${b.filePath})</span>
            <span class="badge" style="background:#ef444433; color:#fca5a5;">Depth ${b.depth}</span>
          </div>
        `;
        cy.$(`#${b.id}`).addClass("highlight-blast");
      });
    } else {
      blastEl.innerHTML = "<p style='color: var(--text-muted); font-size: 0.82rem;'>No downstream callers impacted (Leaf node or entry point).</p>";
    }
  } catch (err) {
    console.error("Failed to fetch node details:", err);
  }
}

function copyNodeCode() {
  const code = document.getElementById("node-code").innerText;
  if (!code) return;
  navigator.clipboard.writeText(code);
  alert("Code snippet copied to clipboard!");
}

function resetHighlights() {
  if (cy) {
    cy.elements().removeClass("highlight-blast");
    cy.elements().removeClass("highlight-search");
    cy.nodes().unselect();
  }
  const searchInput = document.getElementById("node-search");
  if (searchInput) searchInput.value = "";
}

function setLayout(name) {
  if (cy) {
    cy.layout({ name, animate: true, animationDuration: 500 }).run();
  }
}

function fitGraph() {
  if (cy) cy.fit(null, 30);
}

function switchTab(tab) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));

  if (tab === "inspector") {
    document.querySelector(".tab-btn:nth-child(1)").classList.add("active");
    document.getElementById("tab-inspector").classList.add("active");
  } else {
    document.querySelector(".tab-btn:nth-child(2)").classList.add("active");
    document.getElementById("tab-copilot").classList.add("active");
  }
}

// -----------------------------------------------------------------------------
// Interactive Copilot Q&A with Clickable Graph Navigation & Database Persistence
// -----------------------------------------------------------------------------

function renderMessageHtml(role, content, referencedNodes, blastRadius) {
  if (role === "user") {
    return `<div class="chat-bubble bubble-user">${escapeHtml(content)}</div>`;
  }

  const formattedAnswer = formatMarkdown(content);
  let referencesHtml = "";
  if (referencedNodes && referencedNodes.length > 0) {
    referencesHtml = `
      <div style="margin-top: 12px; padding-top: 10px; border-top: 1px solid rgba(255, 255, 255, 0.08); font-size: 0.8rem;">
        <div style="color: var(--text-muted); margin-bottom: 6px; font-weight: 600;">
          <i class="fa-solid fa-code" style="color: var(--primary);"></i> Referenced Symbols:
        </div>
        <div style="display: flex; flex-wrap: wrap; gap: 6px;">
          ${referencedNodes
            .map(
              (n) =>
                `<span class="chat-ref-link" onclick="selectNodeInGraph('${n.id}')" title="Click to view in Dependency Graph">
                  ${escapeHtml(n.name)} <span style="opacity: 0.6; font-size: 0.72rem;">(${escapeHtml(n.filePath)})</span>
                </span>`
            )
            .join("")}
        </div>
      </div>
    `;
  }

  return `<div class="chat-bubble bubble-ai">${formattedAnswer}${referencesHtml}</div>`;
}

async function sendChat() {
  if (isHostedDemoServer) {
    alert("AI Copilot queries are paused on this public demo to protect Gemini API quota. Feel free to explore the interactive code graph, AST relationships, and blast radius calculations!");
    return;
  }

  if (!currentRepoId) {
    alert("Please select or ingest a repository first.");
    return;
  }

  const input = document.getElementById("chat-input");
  const text = input.value.trim();
  if (!text) return;

  const chatBox = document.getElementById("chat-messages");
  const feedContainer = document.getElementById("chat-feed-container");

  // Remove welcome empty state if present
  const welcome = chatBox ? chatBox.querySelector(".chat-welcome-state") : null;
  if (welcome) welcome.remove();

  // If no active thread exists, auto-create one first
  if (!currentThreadId) {
    try {
      const threadRes = await fetch(`/api/repos/${currentRepoId}/threads`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ title: text.slice(0, 40) })
      });
      if (threadRes.ok) {
        const newT = await threadRes.json();
        currentThreadId = newT.id;
        localStorage.setItem("oss_active_thread", currentThreadId);
      }
    } catch (createErr) {
      console.warn("Failed to create thread, continuing anyway:", createErr);
    }
  }

  // Append user message bubble
  if (chatBox) {
    chatBox.innerHTML += `<div class="chat-bubble bubble-user">${escapeHtml(text)}</div>`;
  }
  input.value = "";
  input.style.height = "auto";
  if (feedContainer) feedContainer.scrollTop = feedContainer.scrollHeight;

  const loadingId = "load_" + Date.now();
  if (chatBox) {
    chatBox.innerHTML += `<div id="${loadingId}" class="chat-bubble bubble-ai"><i class="fa-solid fa-spinner fa-spin"></i> Analyzing codebase and graph dependencies...</div>`;
  }
  if (feedContainer) feedContainer.scrollTop = feedContainer.scrollHeight;

  try {
    const endpoint = currentThreadId
      ? `/api/repos/${currentRepoId}/threads/${currentThreadId}/messages`
      : `/api/repos/${currentRepoId}/chat`;

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: JSON.stringify({ question: text })
    });
    const data = await res.json();
    const loadEl = document.getElementById(loadingId);
    if (loadEl) loadEl.remove();

    if (data.error) {
      if (chatBox) {
        chatBox.innerHTML += `<div class="chat-bubble bubble-ai" style="color: var(--danger);">❌ Error: ${escapeHtml(data.error)}</div>`;
      }
      if (feedContainer) feedContainer.scrollTop = feedContainer.scrollHeight;
      return;
    }

    if (chatBox) {
      chatBox.innerHTML += renderMessageHtml("assistant", data.answer, data.referencedNodes, data.blastRadius);
    }
    if (feedContainer) feedContainer.scrollTop = feedContainer.scrollHeight;

    // Refresh threads list in sidebar so auto-generated title updates
    await fetchThreadsForRepo(currentRepoId);
  } catch (err) {
    const loadEl = document.getElementById(loadingId);
    if (loadEl) loadEl.innerHTML = "❌ Failed to get response: " + err.message;
  }
}

// -----------------------------------------------------------------------------
// Ingestion Pipeline Dialog & Job Tracker
// -----------------------------------------------------------------------------

let currentIngestSource = "github";
let isHostedDemoServer = false;

async function checkServerConfig() {
  try {
    const res = await fetch("/api/repos/config");
    if (res.ok) {
      const data = await res.json();
      isHostedDemoServer = Boolean(data.isHostedDemo);
      const demoNotice = document.getElementById("demo-mode-notice");
      const adminGroup = document.getElementById("group-admin-key");
      const sidebarIngestBtn = document.getElementById("btn-sidebar-ingest");
      const chatInput = document.getElementById("chat-input");
      const chatDisclaimer = document.querySelector(".chat-disclaimer");

      if (isHostedDemoServer) {
        if (demoNotice) demoNotice.style.display = "block";
        if (adminGroup) adminGroup.style.display = "block";
        if (sidebarIngestBtn) sidebarIngestBtn.style.display = "none";
        if (chatInput) {
          chatInput.placeholder = "AI Copilot queries are disabled on this demo — click 'View Code Graph' to explore codebase architecture";
        }
        if (chatDisclaimer) {
          chatDisclaimer.innerHTML = `<span style="color: #60a5fa;"><i class="fa-solid fa-circle-info"></i> Public Demo Mode: Read access enabled. Copilot queries and summarization are paused to protect API quota.</span>`;
        }
      } else {
        if (sidebarIngestBtn) sidebarIngestBtn.style.display = "block";
      }
    }
  } catch {
    // Offline or local development
  }
}

function switchIngestSource(source) {
  currentIngestSource = source;
  const btnGithub = document.getElementById("tab-source-github");
  const btnLocal = document.getElementById("tab-source-local");
  const groupGithub = document.getElementById("group-github-url");
  const groupLocal = document.getElementById("group-local-path");
  const inputGithub = document.getElementById("ingest-github-url");
  const inputLocal = document.getElementById("ingest-root-path");

  if (source === "github") {
    btnGithub.classList.add("active");
    btnLocal.classList.remove("active");
    groupGithub.style.display = "block";
    groupLocal.style.display = "none";
    if (inputGithub) inputGithub.required = true;
    if (inputLocal) inputLocal.required = false;
  } else {
    btnLocal.classList.add("active");
    btnGithub.classList.remove("active");
    groupLocal.style.display = "block";
    groupGithub.style.display = "none";
    if (inputLocal) inputLocal.required = true;
    if (inputGithub) inputGithub.required = false;
  }
}

function openIngestModal() {
  const alertEl = document.getElementById("ingest-error-alert");
  if (alertEl) alertEl.style.display = "none";
  document.getElementById("ingest-modal").style.display = "flex";
  checkServerConfig();
}

function closeIngestModal() {
  document.getElementById("ingest-modal").style.display = "none";
}

async function handleIngestSubmit(event) {
  event.preventDefault();
  const alertEl = document.getElementById("ingest-error-alert");
  if (alertEl) alertEl.style.display = "none";

  const githubUrl = document.getElementById("ingest-github-url")?.value?.trim();
  const rootPath = document.getElementById("ingest-root-path")?.value?.trim();
  const name = document.getElementById("ingest-name")?.value?.trim();
  const graphPath = document.getElementById("ingest-graph-path")?.value?.trim();
  const adminKey = document.getElementById("ingest-admin-key")?.value?.trim();

  if (currentIngestSource === "github" && !githubUrl) {
    alert("Please provide a valid GitHub repository URL.");
    return;
  }
  if (currentIngestSource === "local" && !rootPath) {
    alert("Please provide the local repository root path.");
    return;
  }

  closeIngestModal();

  const headers = {
    "Content-Type": "application/json",
    ...getAuthHeaders()
  };
  if (adminKey) {
    headers["x-admin-key"] = adminKey;
  }

  try {
    const res = await fetch("/api/repos/ingest", {
      method: "POST",
      headers,
      body: JSON.stringify({
        repoName: name || undefined,
        repoRootPath: currentIngestSource === "local" ? rootPath : undefined,
        githubUrl: currentIngestSource === "github" ? githubUrl : undefined,
        graphJsonPath: graphPath || undefined,
        adminKey: adminKey || undefined
      })
    });

    const data = await res.json();
    if (!res.ok) {
      alert("Ingestion restricted: " + (data.message || data.error || "Unknown error"));
      return;
    }

    // Launch rich 5-stage pipeline tracker
    trackPipelineJob(data.jobId, data.repoId);
  } catch (err) {
    alert("Network error: " + err.message);
  }
}

// -----------------------------------------------------------------------------
// Live 5-Stage Pipeline Tracker
// -----------------------------------------------------------------------------

function dismissTracker() {
  const tracker = document.getElementById("pipeline-tracker");
  if (tracker) tracker.style.display = "none";
}

let activePollInterval = null;

function trackPipelineJob(jobId, targetRepoId) {
  if (activePollInterval) {
    clearInterval(activePollInterval);
  }

  const tracker = document.getElementById("pipeline-tracker");
  const fill = document.getElementById("tracker-fill");
  const badge = document.getElementById("tracker-percent-badge");
  const heading = document.getElementById("tracker-heading");
  const statusMsg = document.getElementById("tracker-status-message");
  const subDetails = document.getElementById("tracker-sub-details");
  const icon = document.getElementById("tracker-icon");

  if (!tracker) return;

  tracker.style.display = "block";
  if (fill) fill.style.width = "4%";
  if (badge) {
    badge.innerText = "4%";
    badge.style.background = "";
    badge.style.color = "";
  }
  if (heading) heading.innerText = "Ingestion Pipeline Running";
  if (statusMsg) statusMsg.innerText = "Enqueued job in BullMQ...";
  if (subDetails) subDetails.innerText = `Job ID: ${jobId}`;
  if (icon) {
    icon.className = "fa-solid fa-diagram-project fa-spin-pulse";
    icon.style.color = "var(--primary)";
  }

  function updateSteps(activeStepIndex, isComplete = false) {
    for (let i = 1; i <= 5; i++) {
      const stepEl = document.getElementById(`tracker-step-${i}`);
      const divEl = document.getElementById(`tracker-div-${i}`);
      if (!stepEl) continue;

      stepEl.classList.remove("active", "completed");
      if (divEl) divEl.classList.remove("active");

      if (isComplete || i < activeStepIndex) {
        stepEl.classList.add("completed");
        if (divEl) divEl.classList.add("active");
      } else if (i === activeStepIndex) {
        stepEl.classList.add("active");
      }
    }
  }

  updateSteps(1);

  activePollInterval = setInterval(async () => {
    try {
      const res = await fetch(`/api/repos/jobs/${jobId}`, {
        headers: getAuthHeaders()
      });
      if (!res.ok) return;

      const job = await res.json();
      if (!job) return;

      const progress = job.progress || {};
      const percent = progress.percent || 0;
      const message = progress.message || "Processing...";
      const stage = progress.stage || "";

      if (fill) fill.style.width = Math.max(percent, 4) + "%";
      if (badge) badge.innerText = percent + "%";
      if (statusMsg) statusMsg.innerText = message;

      // Update stepper stages
      if (stage === "cloning") {
        updateSteps(1);
        if (heading) heading.innerText = "Phase 1/5: Shallow Cloning Repo";
      } else if (stage === "parsing") {
        if (percent < 20) {
          updateSteps(2);
          if (heading) heading.innerText = "Phase 2/5: AST Parsing & Topo Sorter";
        } else {
          updateSteps(3);
          if (heading) heading.innerText = "Phase 3/5: Checkpoint 1 (PostgreSQL)";
        }
      } else if (stage.startsWith("summarizing")) {
        updateSteps(4);
        if (heading) heading.innerText = "Phase 4/5: LLM Topological Summarization";
      } else if (stage === "saving") {
        updateSteps(5);
        if (heading) heading.innerText = "Phase 5/5: Persisting Final Rollups";
      }

      if (progress.detail && subDetails) {
        const d = progress.detail;
        if (d.currentLevel && d.totalLevels) {
          subDetails.innerText = `Topo Level ${d.currentLevel} of ${d.totalLevels} • Sub-checkpoints committed to PostgreSQL`;
        } else if (d.count && d.totalCount) {
          subDetails.innerText = `${d.count} of ${d.totalCount} items completed`;
        }
      }

      if (job.state === "completed") {
        clearInterval(activePollInterval);
        activePollInterval = null;
        updateSteps(5, true);
        if (fill) fill.style.width = "100%";
        if (badge) {
          badge.innerText = "100%";
          badge.style.background = "rgba(16, 185, 129, 0.2)";
          badge.style.color = "#34d399";
        }
        if (heading) heading.innerText = "✓ Ingestion & Summarization Complete!";
        if (statusMsg) statusMsg.innerText = "Code graph, function contracts, and architecture are ready.";
        if (icon) {
          icon.className = "fa-solid fa-circle-check";
          icon.style.color = "#10b981";
        }

        if (targetRepoId) {
          currentRepoId = targetRepoId;
          localStorage.setItem("oss_active_repo", currentRepoId);
        }

        await loadRepositoriesList();

        setTimeout(() => {
          dismissTracker();
        }, 5000);
      } else if (job.state === "failed") {
        clearInterval(activePollInterval);
        activePollInterval = null;
        if (heading) heading.innerText = "Pipeline Interrupted / Failed";
        if (statusMsg) statusMsg.innerText = "Error: " + (job.failedReason || "Processing failed");
        if (badge) {
          badge.style.background = "rgba(239, 68, 68, 0.2)";
          badge.style.color = "#f87171";
        }
        if (icon) {
          icon.className = "fa-solid fa-circle-exclamation";
          icon.style.color = "#ef4444";
        }
        await loadRepositoriesList();
      }
    } catch (err) {
      console.warn("Poll status error:", err);
    }
  }, 900);
}

// -----------------------------------------------------------------------------
// Delete Repository Handlers
// -----------------------------------------------------------------------------

function openDeleteModal() {
  const repo = repositoriesData.find((r) => r.id === currentRepoId);
  if (!repo) return;

  const nameEl = document.getElementById("delete-repo-name-display");
  const adminGroup = document.getElementById("group-delete-admin-key");
  const alertEl = document.getElementById("delete-error-alert");

  if (nameEl) nameEl.textContent = `"${repo.name}" (${repo.id})`;
  if (alertEl) alertEl.style.display = "none";
  if (adminGroup) {
    adminGroup.style.display = isHostedDemoServer ? "block" : "none";
  }

  document.getElementById("delete-repo-modal").style.display = "flex";
}

function closeDeleteModal() {
  document.getElementById("delete-repo-modal").style.display = "none";
}

async function executeDeleteRepo() {
  if (!currentRepoId) return;

  const adminKey = document.getElementById("delete-admin-key")?.value?.trim();
  const alertEl = document.getElementById("delete-error-alert");
  const btn = document.getElementById("btn-confirm-delete");

  if (btn) btn.disabled = true;

  try {
    const headers = { ...getAuthHeaders() };
    if (adminKey) headers["x-admin-key"] = adminKey;

    const res = await fetch(`/api/repos/${currentRepoId}`, {
      method: "DELETE",
      headers
    });

    const data = await res.json();
    if (!res.ok) {
      if (alertEl) {
        alertEl.textContent = data.message || data.error || "Failed to delete repository.";
        alertEl.style.display = "block";
      }
      return;
    }

    closeDeleteModal();
    currentRepoId = "";
    localStorage.removeItem("oss_active_repo");
    await loadRepositoriesList();
  } catch (err) {
    if (alertEl) {
      alertEl.textContent = "Network error: " + err.message;
      alertEl.style.display = "block";
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

// -----------------------------------------------------------------------------
// Resume / Restart Summarization Handlers
// -----------------------------------------------------------------------------

function openResumeModal() {
  const repo = repositoriesData.find((r) => r.id === currentRepoId);
  if (!repo) return;

  const nameEl = document.getElementById("resume-repo-name-display");
  const statsEl = document.getElementById("resume-repo-stats-display");
  const adminGroup = document.getElementById("group-resume-admin-key");
  const alertEl = document.getElementById("resume-error-alert");

  if (nameEl) nameEl.textContent = `${repo.name} (${repo.id})`;
  if (statsEl) statsEl.textContent = `${repo.summarized_nodes || 0} / ${repo.total_nodes || 0} functions summarized`;
  if (alertEl) alertEl.style.display = "none";
  if (adminGroup) {
    adminGroup.style.display = isHostedDemoServer ? "block" : "none";
  }

  document.getElementById("resume-summary-modal").style.display = "flex";
}

function closeResumeModal() {
  document.getElementById("resume-summary-modal").style.display = "none";
}

async function executeResumeSummarization() {
  if (!currentRepoId) return;

  const adminKey = document.getElementById("resume-admin-key")?.value?.trim();
  const alertEl = document.getElementById("resume-error-alert");
  const mode = document.querySelector('input[name="summary-mode"]:checked')?.value || "resume";
  const isRestart = mode === "restart";

  try {
    const headers = {
      "Content-Type": "application/json",
      ...getAuthHeaders()
    };
    if (adminKey) headers["x-admin-key"] = adminKey;

    const res = await fetch(`/api/repos/${currentRepoId}/resume-summary`, {
      method: "POST",
      headers,
      body: JSON.stringify({ restart: isRestart, adminKey })
    });

    const data = await res.json();
    if (!res.ok) {
      if (alertEl) {
        alertEl.textContent = data.message || data.error || "Failed to trigger summarization.";
        alertEl.style.display = "block";
      }
      return;
    }

    closeResumeModal();
    trackPipelineJob(data.jobId, currentRepoId);
  } catch (err) {
    if (alertEl) {
      alertEl.textContent = "Network error: " + err.message;
      alertEl.style.display = "block";
    }
  }
}

// -----------------------------------------------------------------------------
// Auth & API Key Controls
// -----------------------------------------------------------------------------

let currentAuthTab = "signin";

function openAuthModal() {
  document.getElementById("auth-alert").style.display = "none";
  document.getElementById("auth-modal").style.display = "flex";
}

function closeAuthModal() {
  document.getElementById("auth-modal").style.display = "none";
}

function switchAuthTab(tab) {
  currentAuthTab = tab;
  document.getElementById("tab-btn-signin").classList.toggle("active", tab === "signin");
  document.getElementById("tab-btn-signup").classList.toggle("active", tab === "signup");

  const submitBtn = document.getElementById("auth-submit-btn");
  if (tab === "signin") {
    submitBtn.innerHTML = '<i class="fa-solid fa-arrow-right-to-bracket"></i> Sign In';
  } else {
    submitBtn.innerHTML = '<i class="fa-solid fa-user-plus"></i> Create Account';
  }
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  const alertEl = document.getElementById("auth-alert");
  alertEl.style.display = "none";

  const email = document.getElementById("auth-email").value.trim();
  const password = document.getElementById("auth-password").value.trim();
  const endpoint = currentAuthTab === "signin" ? "/api/auth/login" : "/api/auth/signup";

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();

    if (!res.ok) {
      alertEl.className = "auth-alert error";
      alertEl.innerText = data.message || data.error || "Authentication failed";
      alertEl.style.display = "block";
      return;
    }

    if (data.session && data.session.accessToken) {
      localStorage.setItem("oss_token", data.session.accessToken);
      localStorage.setItem("oss_email", data.session.user?.email || email);
    }

    alertEl.className = "auth-alert success";
    alertEl.innerText = currentAuthTab === "signin" ? "Login successful!" : "Account created successfully!";
    alertEl.style.display = "block";

    setTimeout(() => {
      closeAuthModal();
      updateAuthUI();
    }, 700);
  } catch (err) {
    alertEl.className = "auth-alert error";
    alertEl.innerText = "Network error: " + err.message;
    alertEl.style.display = "block";
  }
}

function signOut() {
  localStorage.removeItem("oss_token");
  localStorage.removeItem("oss_email");
  updateAuthUI();
}

function updateAuthUI() {
  const token = localStorage.getItem("oss_token");
  const email = localStorage.getItem("oss_email");

  const btnLogin = document.getElementById("btn-login-open");
  const userBadge = document.getElementById("user-badge");
  const emailDisplay = document.getElementById("user-email-display");

  if (token && email) {
    btnLogin.style.display = "none";
    userBadge.style.display = "flex";
    emailDisplay.innerText = email.length > 20 ? email.slice(0, 18) + "..." : email;
  } else {
    btnLogin.style.display = "inline-flex";
    userBadge.style.display = "none";
  }
}

async function openApiKeyModal() {
  document.getElementById("key-new-container").style.display = "none";
  document.getElementById("apikey-modal").style.display = "flex";
  await loadApiKeys();
}

function closeApiKeyModal() {
  document.getElementById("apikey-modal").style.display = "none";
}

async function loadApiKeys() {
  const listEl = document.getElementById("api-keys-list");
  listEl.innerHTML = '<div style="text-align: center; color: var(--text-muted); font-size: 0.8rem; padding: 12px;">Loading...</div>';

  try {
    const res = await fetch("/api/auth/api-keys", {
      headers: getAuthHeaders()
    });
    const data = await res.json();

    if (!res.ok || !data.apiKeys || data.apiKeys.length === 0) {
      listEl.innerHTML = '<div style="text-align: center; color: var(--text-muted); font-size: 0.8rem; padding: 12px;">No active API keys found. Generate one above!</div>';
      return;
    }

    listEl.innerHTML = "";
    data.apiKeys.forEach((key) => {
      listEl.innerHTML += `
        <div class="key-list-item">
          <div>
            <div style="font-weight: 600; font-size: 0.84rem;">${key.name}</div>
            <div style="font-family: monospace; font-size: 0.78rem; color: var(--text-muted);">${key.keyPrefix}</div>
          </div>
          <button class="btn btn-secondary" style="color: var(--danger); font-size: 0.8rem; padding: 4px 8px;" onclick="revokeKey('${key.id}')">
            <i class="fa-solid fa-trash"></i>
          </button>
        </div>
      `;
    });
  } catch (err) {
    listEl.innerHTML = `<div style="color: var(--danger); font-size: 0.8rem; padding: 12px;">Failed to load keys: ${err.message}</div>`;
  }
}

async function generateApiKey() {
  const nameInput = document.getElementById("new-key-name");
  const name = nameInput.value.trim() || "CLI & Agent Key";

  try {
    const res = await fetch("/api/auth/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: JSON.stringify({ name })
    });
    const data = await res.json();

    if (res.ok && data.apiKey) {
      nameInput.value = "";
      const newKeyBox = document.getElementById("key-new-container");
      const keyValue = document.getElementById("new-key-value");
      keyValue.value = data.apiKey;
      newKeyBox.style.display = "block";
      await loadApiKeys();
    } else {
      alert("Failed to generate key: " + (data.message || data.error));
    }
  } catch (err) {
    alert("Error: " + err.message);
  }
}

function copyNewKey() {
  const keyValue = document.getElementById("new-key-value");
  keyValue.select();
  navigator.clipboard.writeText(keyValue.value);
  alert("API Key copied to clipboard! Keep it safe.");
}

async function revokeKey(id) {
  if (!confirm("Revoke this API key? AI agents or CLI instances using it will immediately lose access.")) return;

  try {
    await fetch(`/api/auth/api-keys/${id}`, {
      method: "DELETE",
      headers: getAuthHeaders()
    });
    await loadApiKeys();
  } catch (err) {
    alert("Failed to revoke: " + err.message);
  }
}

// -----------------------------------------------------------------------------
// Application Lifecycle Initialization
// -----------------------------------------------------------------------------

window.onload = async () => {
  await checkServerConfig();
  updateAuthUI();
  await loadRepositoriesList();
};
