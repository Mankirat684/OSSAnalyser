---
name: summarize-codebase
description: >-
  Interactive workflow to estimate token costs, select an LLM provider/model (Active Harness Model e.g. Gemini 3.8 Flash, Cloud Gemini, Ollama, Heuristic),
  and run the hierarchical bottom-up codebase summarization pipeline. Use when the user asks to summarize the
  codebase, estimate summarization costs, or invokes /summarize.
---

# Hierarchical Codebase Summarization Workflow

This skill guides the harness through estimating token costs, prompting the user for their preferred LLM provider and model, and running the bottom-up summarization pipeline.

---

## Step 1: Pre-Flight Estimation

Always run the pre-flight estimator first without calling the LLM to inspect how many functions, files, and modules need summarization and calculate the estimated token spend:

```powershell
npx oss-analyser summarize --estimate
```
*(Or `npm run cli -- summarize --estimate` during local development)*

Display the estimated token count, dollar cost, and node breakdown to the user.

---

## Step 2: Prompt User for Model & Provider Selection

Ask the user which model and provider they wish to use before triggering the LLM calls.

Present these standard options:

1. **Harness Active Model (In-Chat / Subagent - Zero External Setup)**
   - Provider: `harness`
   - *Uses the active model in this conversation (e.g. Gemini 3.8 Flash or Claude). The agent runs the loop using `get_summary_batch` and `save_summary_batch` MCP tools. Requires 0 API keys and 0 external servers.*
2. **Gemini 3.5 Flash Lite (Recommended for Fast Cloud API)**
   - Provider: `gemini`
   - Model: `gemini-3.5-flash-lite`
   - *Best balance of low token cost ($0.075/1M tokens) and fast bottom-up AST summarization. Requires `GEMINI_API_KEY`.*
3. **Gemini 3.5 Flash / Pro (High Quality Cloud)**
   - Provider: `gemini`
   - Model: `gemini-3.5-flash` (or `gemini-3.5-pro`)
   - *Richer docstrings for complex codebases. Requires `GEMINI_API_KEY`.*
4. **Local Ollama (100% Free & Private Offline)**
   - Provider: `ollama`
   - Model: `qwen2.5-coder` (or `llama3.2`, `codellama`)
   - *Zero API cost, fully offline. Requires local Ollama server running at `http://localhost:11434`.*
5. **Heuristic Simulation (Zero LLM Tokens)**
   - Provider: `heuristic`
   - *Generates structural summaries from AST signatures and existing doc comments without calling any external LLM.*

---

## Step 3: Run the Summarization Pipeline

### If the user chooses the Harness Active Model:
Execute the in-chat agent loop:
1. Call `get_summary_batch()` to retrieve the next unsummarized functions (ordered bottom-up by topological level with callee summaries).
2. The agent analyzes the code and generates the summaries JSON.
3. Call `save_summary_batch({ summaries: [...] })` to commit them into SQLite.
4. Repeat until `hasMore: false`.

### If the user chooses a CLI Provider (Gemini / Ollama / Heuristic):
Run the automated CLI command:
```powershell
# Example: Gemini 3.5 Flash Lite
npx oss-analyser summarize --provider gemini --model gemini-3.5-flash-lite --yes

# Example: Local Ollama
npx oss-analyser summarize --provider ollama --model qwen2.5-coder --yes

# Example: Heuristic Simulation
npx oss-analyser summarize --provider heuristic --yes
```

If the user also wants to re-summarize functions whose callers were modified, append `--include-possibly-stale`.

---

## Step 4: Verify Summary Coverage

After completion, run the status command to confirm the updated coverage:

```powershell
npx oss-analyser status
```

Report the total symbols summarized, coverage percentage, and database status to the user.
