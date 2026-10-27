import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

export interface InstallOptions {
  harness?: "claude-code" | "cursor" | "antigravity" | "generic";
  dryRun?: boolean;
  repo?: string;
}

export async function runInstallCommand(options: InstallOptions): Promise<void> {
  const repoRoot = path.resolve(options.repo || process.cwd());
  const harness = options.harness || "claude-code";

  console.log(`\n==========================================================`);
  console.log(`  OSS Analyser: Harness Integration Installer`);
  console.log(`==========================================================`);
  console.log(`Target Repository : ${repoRoot}`);
  console.log(`Target Harness    : ${harness}`);
  console.log(`Dry Run           : ${options.dryRun ? "YES" : "NO"}\n`);

  // 1. Configure .mcp.json
  const mcpConfigPath = path.join(repoRoot, ".mcp.json");
  let existingMcpConfig: { mcpServers?: Record<string, unknown> } = {};

  if (fs.existsSync(mcpConfigPath)) {
    try {
      existingMcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, "utf-8"));
    } catch {
      existingMcpConfig = {};
    }
  }

  const updatedMcpConfig = {
    ...existingMcpConfig,
    mcpServers: {
      ...(existingMcpConfig.mcpServers || {}),
      "oss-analyser": {
        command: "npx",
        args: ["-y", "ossanalyser", "serve"]
      }
    }
  };

  const mcpJsonStr = JSON.stringify(updatedMcpConfig, null, 2);

  if (options.dryRun) {
    console.log(`[Dry Run] Planned changes for ${mcpConfigPath}:`);
    console.log(mcpJsonStr);
  } else {
    fs.writeFileSync(mcpConfigPath, mcpJsonStr, "utf-8");
    console.log(`✓ Configured MCP server in: .mcp.json`);
  }

  // 2. Install Claude Code Slash Commands
  const claudeCommandsDir = path.join(repoRoot, ".claude", "commands");
  const ossAnalyseCmdPath = path.join(claudeCommandsDir, "ossAnalyse.md");
  const summarizeCmdPath = path.join(claudeCommandsDir, "summarize.md");

  const ossAnalyseContent = `---
description: Consult OSS Analyser for architecture, call graphs, and blast radius before editing
---

When tackling code-understanding, feature development, or refactoring tasks, drive your own traversal using OSS Analyser primitives:
1. **Search Primitive**: Call \`search_symbols(query, mode="semantic")\` or \`search_symbols(query, mode="lexical")\` with your own keywords or questions to discover candidate symbols and their pre-computed summaries.
2. **Inspect Contracts**: Call \`get_symbol\` or \`get_file_contract\` on targets to inspect signatures, line coordinates, and doc summaries without loading full files.
3. **Graph Traversal**: Call \`get_callers\` or \`get_callees\` to trace dependencies, and \`get_blast_radius\` before modifying a symbol to inspect upstream impact.
4. *(Optional Shortcut)*: For a quick one-shot context bundle, \`get_relevant_context\` is available as an automated macro.
5. Always verify code against source files before applying edits.
`;

  const summarizeContent = `---
description: Estimate token costs, select model/provider, and run hierarchical codebase summarization
---

Runs pre-flight cost estimation and executes bottom-up codebase summarization:
1. **Pre-flight Estimation**: Runs \`oss-analyser summarize --estimate\` and displays node counts and token/cost estimates to the user.
2. **Model Selection**: Asks the user which provider and model to use:
   - \`harness\` (active chat session model, e.g. Claude or Gemini, runs via MCP batch tools \`get_summary_batch\` and \`save_summary_batch\`, requires 0 API keys)
   - \`gemini\` (model: \`gemini-3.5-flash-lite\` or \`gemini-3.5-flash\`, requires \`GEMINI_API_KEY\`)
   - \`ollama\` (model: \`qwen2.5-coder\` or \`llama3.2\`, free local server)
   - \`heuristic\` (zero LLM tokens, uses AST signatures & docstrings)
3. **Execution**:
   - If harness: Agent drives the loop calling \`get_summary_batch\` and committing with \`save_summary_batch\`.
   - If CLI provider: Executes \`oss-analyser summarize --provider <provider> --model <model> --yes\`.
4. **Verification**: Runs \`oss-analyser status\` to verify and display updated summary coverage.
`;

  if (options.dryRun) {
    console.log(`\n[Dry Run] Planned slash commands in ${claudeCommandsDir}/:`);
    console.log(`  • /ossAnalyse`);
    console.log(`  • /summarize`);
  } else {
    if (!fs.existsSync(claudeCommandsDir)) {
      fs.mkdirSync(claudeCommandsDir, { recursive: true });
    }
    fs.writeFileSync(ossAnalyseCmdPath, ossAnalyseContent, "utf-8");
    fs.writeFileSync(summarizeCmdPath, summarizeContent, "utf-8");
    console.log(`✓ Installed slash commands in: .claude/commands/ (/ossAnalyse, /summarize)`);
  }

  // 3. Configure Antigravity MCP and Agent Rules
  if (harness === "antigravity" || harness === "generic") {
    const globalGeminiConfig = path.join(os.homedir(), ".gemini", "config");
    const globalMcpPath = path.join(globalGeminiConfig, "mcp_config.json");
    let globalMcpConfig: { mcpServers?: Record<string, unknown> } = {};

    if (fs.existsSync(globalMcpPath)) {
      try {
        const raw = fs.readFileSync(globalMcpPath, "utf-8").trim();
        if (raw) globalMcpConfig = JSON.parse(raw);
      } catch {
        globalMcpConfig = {};
      }
    }

    globalMcpConfig.mcpServers = {
      ...(globalMcpConfig.mcpServers || {}),
      "oss-analyser": {
        command: "oss-analyser",
        args: ["serve"]
      }
    };

    if (options.dryRun) {
      console.log(`\n[Dry Run] Planned changes for Antigravity ${globalMcpPath}:`);
      console.log(JSON.stringify(globalMcpConfig, null, 2));
    } else {
      if (!fs.existsSync(globalGeminiConfig)) {
        fs.mkdirSync(globalGeminiConfig, { recursive: true });
      }
      fs.writeFileSync(globalMcpPath, JSON.stringify(globalMcpConfig, null, 2), "utf-8");
      console.log(`✓ Configured Antigravity MCP server in: ~/.gemini/config/mcp_config.json`);
    }

    // Install workspace agent rule for Antigravity
    const agentsRulesDir = path.join(repoRoot, ".agents", "rules");
    const agentRulePath = path.join(agentsRulesDir, "oss-analyser.md");
    const agentRuleContent = `# OSS Analyser Architectural Context Rules

When answering architecture questions, planning changes, or editing symbols, prefer agent-driven traversal over loading full raw source files:
1. **Search Primitive**: Call \`search_symbols(query, mode="semantic")\` or \`search_symbols(query, mode="lexical")\` with your own wording to locate candidate functions and files. It returns matching nodes with similarity scores and one-line summaries.
2. **Inspect Contracts**: Use \`get_symbol\` to inspect signatures, line coordinates, and pre-computed summaries for symbols of interest, or \`get_file_contract\` for file-level overviews.
3. **Graph Traversal**: Use \`get_callers\`, \`get_callees\`, and \`get_blast_radius\` to trace upstream/downstream dependencies before refactoring.
4. **Shortcut**: If you need a quick automated context package in a single turn, use \`get_relevant_context(task)\` as a convenience macro.
5. Always verify generated code against source files before applying edits.
`;

    // Install workspace summarization skill for Antigravity
    const agentsSkillDir = path.join(repoRoot, ".agents", "skills", "summarize-codebase");
    const agentSkillPath = path.join(agentsSkillDir, "SKILL.md");
    const agentSkillContent = `---
name: summarize-codebase
description: >-
  Interactive workflow to estimate token costs, select an LLM provider/model (Active Harness Model e.g. Gemini 3.8 Flash, Cloud Gemini, Ollama, Heuristic),
  and run the hierarchical bottom-up codebase summarization pipeline. Use when the user asks to summarize the
  codebase, estimate summarization costs, or invokes /summarize.
---

# Hierarchical Codebase Summarization Workflow

This skill guides the harness through estimating token costs, prompting the user for their preferred LLM provider and model, and running the bottom-up summarization pipeline.

## Step 1: Pre-Flight Estimation
Run the pre-flight estimator to calculate token spend and node counts:
\`\`\`bash
npx oss-analyser summarize --estimate
\`\`\`
Display the estimated token count, dollar cost, and node breakdown to the user.

## Step 2: Prompt User for Model & Provider Selection
Ask the user which model and provider they wish to use before triggering summarization. In Antigravity, invoke \`ask_question\` with these options:
1. **(Recommended) Active Harness Model (In-Chat / Zero Setup)**: Provider: \`harness\`. Uses the currently active model in this conversation (e.g. Gemini 3.8 Flash or Claude). The agent runs the loop using \`get_summary_batch\` and \`save_summary_batch\` MCP tools. Requires 0 API keys and 0 external servers.
2. **Gemini 3.5 Flash Lite (Fast Cloud API)**: Provider: \`gemini\`, Model: \`gemini-3.5-flash-lite\` (requires \`GEMINI_API_KEY\`)
3. **Gemini 3.5 Flash / Pro (High Quality Cloud)**: Provider: \`gemini\`, Model: \`gemini-3.5-flash\` or \`gemini-3.5-pro\` (requires \`GEMINI_API_KEY\`)
4. **Local Ollama (100% Free & Private Offline)**: Provider: \`ollama\`, Model: \`qwen2.5-coder\` or \`llama3.2\` (requires local Ollama server at \`http://localhost:11434\`)
5. **Heuristic Simulation (Zero LLM Tokens)**: Provider: \`heuristic\` (uses AST signatures & docstrings without external LLM)

## Step 3: Run the Summarization Pipeline
- **If Active Harness Model**: Execute the agent loop:
  1. Call \`get_summary_batch()\` to retrieve unsummarized functions ordered bottom-up with callee summaries.
  2. The agent generates the summaries JSON in-session.
  3. Call \`save_summary_batch({ summaries: [...] })\` to commit them into SQLite.
  4. Repeat until \`hasMore: false\`.
- **If CLI Provider (Gemini / Ollama / Heuristic)**:
  Run the automated CLI command:
  \`\`\`bash
  npx oss-analyser summarize --provider <provider> --model <model> --yes
  \`\`\`

## Step 4: Verify Summary Coverage
Confirm updated coverage:
\`\`\`bash
npx oss-analyser status
\`\`\`
`;

    if (!options.dryRun) {
      if (!fs.existsSync(agentsRulesDir)) {
        fs.mkdirSync(agentsRulesDir, { recursive: true });
      }
      fs.writeFileSync(agentRulePath, agentRuleContent, "utf-8");
      console.log(`✓ Installed Antigravity workflow rule in: .agents/rules/oss-analyser.md`);

      if (!fs.existsSync(agentsSkillDir)) {
        fs.mkdirSync(agentsSkillDir, { recursive: true });
      }
      fs.writeFileSync(agentSkillPath, agentSkillContent, "utf-8");
      console.log(`✓ Installed Antigravity skill in: .agents/skills/summarize-codebase/SKILL.md`);
    }
  }

  console.log(`\n🎉 Installation successfully completed!`);
  console.log(`Coding harnesses (Claude Code, Cursor, Antigravity) can now seamlessly query OSS Analyser.\n`);
}
