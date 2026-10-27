---
description: Estimate token costs, select model/provider, and run hierarchical codebase summarization
---

Runs pre-flight cost estimation and executes bottom-up codebase summarization:
1. **Pre-flight Estimation**: Runs `oss-analyser summarize --estimate` and displays node counts and token/cost estimates to the user.
2. **Model Selection**: Asks the user which provider and model to use:
   - `gemini` (model: `gemini-3.5-flash-lite` or `gemini-3.5-flash`, requires `GEMINI_API_KEY`)
   - `ollama` (model: `qwen2.5-coder` or `llama3.2`, free local server)
   - `heuristic` (zero LLM tokens, uses AST signatures & docstrings)
3. **Execution**: Executes `oss-analyser summarize --provider <provider> --model <model> --yes` with user confirmation.
4. **Verification**: Runs `oss-analyser status` to verify and display updated summary coverage.
