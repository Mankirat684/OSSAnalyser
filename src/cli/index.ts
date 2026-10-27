#!/usr/bin/env node
import * as dotenv from "dotenv";
dotenv.config();

import { Command } from "commander";
import { runInitCommand } from "./commands/init.js";
import { runIndexCommand } from "./commands/index.js";
import { runEmbedCommand } from "./commands/embed.js";
import { runStatusCommand } from "./commands/status.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { runImpactCommand } from "./commands/impact.js";
import { runServeCommand } from "./commands/serve.js";
import { runSummarizeCommand } from "./commands/summarize.js";
import { runQueryCommand } from "./commands/query.js";
import { runInstallCommand } from "./commands/install.js";
import { runExportCommand } from "./commands/export.js";

const program = new Command();

program
  .name("oss-analyser")
  .description("OSS Analyser: Local-first Context Engine & MCP Server for AI Coding Harnesses")
  .version("1.0.0");

program
  .command("init")
  .description("Initialize .oss-analyser/ workspace, config, and SQLite database")
  .option("--repo <path>", "Path to target repository (default: current working directory)")
  .option("-f, --force", "Overwrite existing configuration")
  .action(async (opts) => {
    try {
      await runInitCommand(opts);
    } catch (err: any) {
      console.error(`Error during init: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("index")
  .description("Scan workspace, extract AST symbols, resolve call graph edges, and detect cycles")
  .option("--repo <path>", "Path to target repository (default: current working directory)")
  .option("--full", "Force full re-extraction instead of incremental change detection")
  .option("--no-blame", "Skip git blame author attribution")
  .option("--extractor <type>", "AST extractor engine: native | graphify (default: native)")
  .option("--json", "Output results in JSON format")
  .action(async (opts) => {
    try {
      await runIndexCommand(opts);
    } catch (err: any) {
      console.error(`Error during index: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("embed")
  .description("Generate dense vector embeddings for code symbols and contracts using local ONNX or cloud models")
  .option("--repo <path>", "Path to target repository (default: current working directory)")
  .option("--provider <name>", "Embedding provider: local | onnx | gemini | hash (default: local)")
  .option("--model <name>", "Model name override (e.g. Xenova/bge-base-en-v1.5)")
  .option("-f, --force", "Force re-embedding of all nodes even if unchanged")
  .option("--json", "Output results in JSON format")
  .action(async (opts) => {
    try {
      await runEmbedCommand(opts);
    } catch (err: any) {
      console.error(`Error during embed: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("summarize")
  .description("Generate hierarchical LLM summaries (function -> file -> module -> repo)")
  .option("--repo <path>", "Path to target repository (default: current working directory)")
  .option("--estimate", "Calculate and print token/cost estimate without calling LLM")
  .option("--yes", "Proceed without interactive confirmation")
  .option("--provider <name>", "LLM provider: gemini | ollama | heuristic | harness (default: gemini)")
  .option("--model <name>", "Model name override")
  .option("--api-key <key>", "Gemini API key override (or use GEMINI_API_KEY env)")
  .option("--include-possibly-stale", "Re-summarize functions whose callers were marked possibly stale")
  .option("--get-batch", "Export next topological batch prompt for harness or external LLM")
  .option("--save-batch <file>", "Save JSON summaries file back into local database")
  .option("--reset", "Reset summaries to missing to enable full re-summarization")
  .option("--reset-scope <scope>", "Scope for reset: all | possibly_stale | heuristic (default: all)")
  .option("--json", "Output results in JSON format")
  .action(async (opts) => {
    try {
      await runSummarizeCommand(opts);
    } catch (err: any) {
      console.error(`Error during summarize: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("status")
  .description("Inspect local knowledge base commit freshness, symbol counts, and coverage")
  .option("--repo <path>", "Path to target repository (default: current working directory)")
  .option("--json", "Output status in JSON format")
  .action(async (opts) => {
    try {
      await runStatusCommand(opts);
    } catch (err: any) {
      console.error(`Error during status: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("doctor")
  .description("Check Node runtime, SQLite FTS5, Git, and environment health")
  .option("--repo <path>", "Path to target repository (default: current working directory)")
  .action(async (opts) => {
    try {
      await runDoctorCommand(opts);
    } catch (err: any) {
      console.error(`Error during doctor: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("impact <symbol>")
  .description("Calculate transitive blast radius and affected files for a symbol")
  .option("--repo <path>", "Path to target repository (default: current working directory)")
  .option("--depth <number>", "Maximum recursion depth (default: 3)")
  .option("--include-inferred", "Include untyped or name-only calls")
  .option("--json", "Output blast radius in JSON format")
  .action(async (symbol, opts) => {
    try {
      await runImpactCommand(symbol, opts);
    } catch (err: any) {
      console.error(`Error during impact: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("serve")
  .description("Launch stdio Model Context Protocol (MCP) server for AI coding agents")
  .option("--repo <path>", "Path to target repository (default: current working directory)")
  .option("--watch", "Watch workspace and automatically update index in background")
  .action(async (opts) => {
    try {
      await runServeCommand(opts);
    } catch (err: any) {
      console.error(`Error during serve: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("query <task>")
  .description("Query codebase context using hybrid RRF retrieval (CLI debugging view of get_relevant_context)")
  .option("--repo <path>", "Path to target repository (default: current working directory)")
  .option("--max-tokens <number>", "Maximum token budget (default: 2000, cap: 8000)")
  .option("--mode <mode>", "Retrieval mode: hybrid | lexical | semantic (default: hybrid)")
  .option("--json", "Output response envelope in JSON format")
  .option("--debug", "Include ranking and scoring diagnostics")
  .action(async (task, opts) => {
    try {
      await runQueryCommand(task, opts);
    } catch (err: any) {
      console.error(`Error during query: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("install")
  .description("Automatically configure MCP server in harness configuration (.mcp.json) and install slash commands")
  .option("--repo <path>", "Path to target repository (default: current working directory)")
  .option("--harness <type>", "Harness type: claude-code | cursor | antigravity | generic (default: claude-code)")
  .option("--dry-run", "Preview planned configuration without writing files")
  .action(async (opts) => {
    try {
      await runInstallCommand(opts);
    } catch (err: any) {
      console.error(`Error during install: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("export")
  .alias("sync")
  .description("Export local SQLite knowledge graph to PostgreSQL web dashboard or portable JSON dump")
  .option("--postgres", "Export to PostgreSQL database (uses DATABASE_URL env)")
  .option("--url <connectionString>", "PostgreSQL connection string override")
  .option("--dump <file.json>", "Export knowledge graph to a portable JSON file")
  .option("--import-dump <file.json>", "Import knowledge graph from a JSON file into local SQLite")
  .option("--repo <path>", "Path to target repository (default: current working directory)")
  .option("--json", "Output results in JSON format")
  .action(async (opts) => {
    try {
      await runExportCommand(opts);
    } catch (err: any) {
      console.error(`Error during export: ${err.message}`);
      process.exit(1);
    }
  });

program.parse(process.argv);
