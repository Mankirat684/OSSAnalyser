import * as readline from "node:readline";
import * as path from "node:path";
import { pool } from "../../config/database.js";
import { RepositoryStore } from "../../modules/storage/index.js";
import { CodebaseCopilot } from "../../modules/copilot/index.js";
import { enqueueRepoIngestion, getIngestionJobStatus } from "../../modules/queue/index.js";
import { AuthService } from "../../modules/auth/index.js";

const copilot = new CodebaseCopilot();
let currentAuthUser: { id: string; email?: string } | null = null;

function printBanner() {
  console.log(`
╔════════════════════════════════════════════════════════════════════╗
║                   OSS ANALYSER — INTERACTIVE CLI                   ║
║   Code Graph • Hierarchical Summaries • Blast Radius • Git Blame   ║
╚════════════════════════════════════════════════════════════════════╝
`);
  console.log("Commands:");
  console.log("  login <email> <pwd>  - Authenticate with Supabase");
  console.log("  apikey [name]        - Generate/view an API key for CLI & AI Agents");
  console.log("  repos                - List all indexed repositories");
  console.log("  ask <question>       - Ask a question to the onboarding Copilot");
  console.log("  blast <symbol>       - Calculate blast radius for a symbol");
  console.log("  owner <symbol>       - View Git ownership breakdown for a symbol");
  console.log("  inspect <symbol>     - Inspect code, signatures, and summaries");
  console.log("  ingest <path> [name] - Ingest a repository from disk");
  console.log("  help                 - Show this help menu");
  console.log("  exit                 - Quit the CLI\n");
}

async function handleCommand(input: string, currentRepoId: string): Promise<string> {
  const trimmed = input.trim();
  if (!trimmed) return currentRepoId;

  const [cmd, ...args] = trimmed.split(" ");
  const argText = args.join(" ").trim();

  switch (cmd.toLowerCase()) {
    case "help":
      printBanner();
      break;

    case "login": {
      const parts = argText.split(" ");
      const email = parts[0];
      const password = parts[1];
      if (!email || !password) {
        console.log("Usage: login <email> <password>");
        break;
      }
      try {
        console.log(`Authenticating ${email}...`);
        const session = await AuthService.signIn(email, password);
        currentAuthUser = { id: session.user.id, email: session.user.email };
        console.log(`✓ Logged in as: ${session.user.email} (ID: ${session.user.id})`);
      } catch (err: any) {
        console.log(`❌ Login failed: ${err.message}`);
      }
      break;
    }

    case "apikey": {
      const userId = currentAuthUser?.id || "cli_developer_user";
      const userEmail = currentAuthUser?.email || "cli@ossanalyser.local";
      const keyName = argText || "CLI Generated Key";
      try {
        const { rawKey, keyRecord } = await AuthService.createApiKey(userId, userEmail, keyName);
        console.log(`\n✓ New API Key Generated:`);
        console.log(`  Key: ${rawKey}`);
        console.log(`  Name: ${keyRecord.name}`);
        console.log(`  Prefix: ${keyRecord.keyPrefix}`);
        console.log(`💡 Set this in your terminal or agent: export OSS_API_KEY="${rawKey}"\n`);
      } catch (err: any) {
        console.log(`❌ Failed to create API key: ${err.message}`);
      }
      break;
    }

    case "repos": {
      const res = await pool.query(
        `SELECT id, name, root_path, architecture_summary, indexed_at FROM repositories ORDER BY indexed_at DESC`
      );
      if (res.rows.length === 0) {
        console.log("No repositories found in database. Use 'ingest <path>' to add one.");
      } else {
        console.log("\nIndexed Repositories:");
        res.rows.forEach((r, idx) => {
          const active = r.id === currentRepoId ? " [ACTIVE]" : "";
          console.log(`  ${idx + 1}. [${r.id}] ${r.name}${active}`);
          console.log(`     Path: ${r.root_path}`);
          console.log(`     Summary: ${r.architecture_summary || "N/A"}`);
        });
        console.log();
      }
      break;
    }

    case "use": {
      if (!argText) {
        console.log("Usage: use <repoId>");
      } else {
        currentRepoId = argText;
        console.log(`✓ Active repository set to: ${currentRepoId}`);
      }
      break;
    }

    case "ask": {
      if (!argText) {
        console.log("Usage: ask <your question here>");
        break;
      }
      console.log(`\n🔍 Analyzing codebase for: "${argText}"...\n`);
      const res = await copilot.answerQuestion(currentRepoId, argText);
      console.log(res.answer);

      if (res.referencedNodes.length > 0) {
        console.log("\n📌 Referenced Symbols:");
        res.referencedNodes.forEach((n) => {
          console.log(`  - ${n.name} (${n.filePath})`);
        });
      }
      console.log();
      break;
    }

    case "blast": {
      if (!argText) {
        console.log("Usage: blast <functionOrSymbolName>");
        break;
      }

      const nodeRes = await pool.query(
        `SELECT id, name, file_path FROM code_nodes WHERE repo_id = $1 AND name ILIKE $2 LIMIT 1`,
        [currentRepoId, `%${argText}%`]
      );

      if (nodeRes.rows.length === 0) {
        console.log(`Symbol "${argText}" not found in repository ${currentRepoId}.`);
        break;
      }

      const node = nodeRes.rows[0];
      console.log(`\n💥 Computing Blast Radius for: ${node.name} (${node.file_path})...`);
      const blast = await RepositoryStore.getBlastRadius(currentRepoId, node.id);

      if (blast.length === 0) {
        console.log("  No upstream dependents affected (Leaf node / entry point).\n");
      } else {
        console.log(`  ${blast.length} upstream caller(s) would be affected:\n`);
        blast.forEach((b) => {
          console.log(`  └── [Depth ${b.depth}] ${b.name} (${b.filePath})`);
          console.log(`      Summary: ${b.summary}`);
        });
        console.log();
      }
      break;
    }

    case "owner": {
      if (!argText) {
        console.log("Usage: owner <functionOrSymbolName>");
        break;
      }

      const nodeRes = await pool.query(
        `SELECT id, name, file_path FROM code_nodes WHERE repo_id = $1 AND name ILIKE $2 LIMIT 1`,
        [currentRepoId, `%${argText}%`]
      );

      if (nodeRes.rows.length === 0) {
        console.log(`Symbol "${argText}" not found in repository ${currentRepoId}.`);
        break;
      }

      const node = nodeRes.rows[0];
      const details = await RepositoryStore.getNodeDetails(currentRepoId, node.id);

      console.log(`\n👤 Git Ownership & Authorship for: ${node.name} (${node.file_path})`);
      if (!details || details.ownership.length === 0) {
        console.log("  No git ownership records found.\n");
      } else {
        details.ownership.forEach((o) => {
          console.log(`  - ${o.authorName} <${o.authorEmail}>: ${o.ownershipPercentage}% (${o.linesAuthored} lines, ${o.totalCommits} commits)`);
          console.log(`    Last Modified: ${new Date(o.lastCommitDate).toLocaleString()}`);
        });
        console.log();
      }
      break;
    }

    case "inspect": {
      if (!argText) {
        console.log("Usage: inspect <functionOrSymbolName>");
        break;
      }

      const nodeRes = await pool.query(
        `SELECT id, name, file_path FROM code_nodes WHERE repo_id = $1 AND name ILIKE $2 LIMIT 1`,
        [currentRepoId, `%${argText}%`]
      );

      if (nodeRes.rows.length === 0) {
        console.log(`Symbol "${argText}" not found in repository ${currentRepoId}.`);
        break;
      }

      const node = nodeRes.rows[0];
      const details = await RepositoryStore.getNodeDetails(currentRepoId, node.id);

      if (!details) {
        console.log(`Details not found for ${node.name}.`);
        break;
      }

      console.log(`\n======================================================`);
      console.log(`Symbol: ${details.node.name} (${details.node.nodeType})`);
      console.log(`File: ${details.node.filePath}`);
      console.log(`Summary: ${details.node.summary}`);
      console.log(`Callees: [${details.callees.map((c) => c.name).join(", ")}]`);
      console.log(`Callers: [${details.callers.map((c) => c.name).join(", ")}]`);
      if (details.node.rawCode) {
        console.log(`\nCode Snippet:\n${details.node.rawCode}`);
      }
      console.log(`======================================================\n`);
      break;
    }

    case "ingest": {
      const repoPath = args[0];
      if (!repoPath) {
        console.log("Usage: ingest <repoRootPath> [repoName]");
        break;
      }

      const fullRepoPath = path.resolve(process.cwd(), repoPath);
      const graphJsonPath = path.resolve(fullRepoPath, "graphify-out/graph.json");
      const repoName = args[1] || path.basename(fullRepoPath);
      const repoId = `repo_${Date.now()}`;

      console.log(`\n⏳ Ingesting repository: "${repoName}" from ${fullRepoPath}...`);

      const job = await enqueueRepoIngestion({
        repoId,
        repoName,
        repoRootPath: fullRepoPath,
        graphJsonPath
      });

      console.log(`✓ Job enqueued (ID: ${job.id}). Polling progress...`);

      let done = false;
      while (!done) {
        await new Promise((r) => setTimeout(r, 600));
        const status = await getIngestionJobStatus(String(job.id));
        if (status) {
          process.stdout.write(`\r  Progress: [${status.state.toUpperCase()}] ${status.progress?.percent ?? 0}% - ${status.progress?.message ?? ""}`);
          if (status.state === "completed") {
            done = true;
            console.log(`\n✓ Ingestion completed! Active repository set to: ${repoId}\n`);
            currentRepoId = repoId;
          } else if (status.state === "failed") {
            done = true;
            console.log(`\n❌ Ingestion failed: ${status.failedReason}\n`);
          }
        }
      }
      break;
    }

    default:
      console.log(`Unknown command: "${cmd}". Type "help" for available commands.`);
      break;
  }

  return currentRepoId;
}

export async function runCli(): Promise<void> {
  printBanner();

  let currentRepoId = "repo_test_123";

  // Check if active repo exists, else pick latest
  const latestRepo = await pool.query(
    `SELECT id, name FROM repositories ORDER BY indexed_at DESC LIMIT 1`
  );
  if (latestRepo.rows.length > 0) {
    currentRepoId = latestRepo.rows[0].id;
    console.log(`Active Repository: [${currentRepoId}] ${latestRepo.rows[0].name}\n`);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `ossanalyser (${currentRepoId})> `
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (trimmed.toLowerCase() === "exit" || trimmed.toLowerCase() === "quit") {
      console.log("Goodbye!");
      process.exit(0);
    }

    try {
      currentRepoId = await handleCommand(trimmed, currentRepoId);
    } catch (err) {
      console.error("Error executing command:", err);
    }

    rl.setPrompt(`ossanalyser (${currentRepoId})> `);
    rl.prompt();
  });
}

if (process.argv[1]?.includes("cli")) {
  runCli().catch((err) => {
    console.error("CLI failure:", err);
    process.exit(1);
  });
}
