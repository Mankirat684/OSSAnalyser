import { Worker, Job, UnrecoverableError } from "bullmq";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { getRedisConnectionOptions } from "../../config/redis.js";
import { pool } from "../../config/database.js";
import { REPO_INGESTION_QUEUE_NAME } from "./ingestQueue.js";
import { runAnalyzerPipeline, ensureGraphJson } from "../analyzer/index.js";
import { GeminiSummarizerClient, summarizeCodebaseHierarchically } from "../summarizer/index.js";
import { RepositoryStore } from "../storage/index.js";
import type {
  RepoIngestionJobData,
  RepoIngestionJobResult,
  JobProgress,
  AnalyzerPipelineResult
} from "../../core/types.js";

let workerInstance: Worker<RepoIngestionJobData, RepoIngestionJobResult> | null = null;

export function createIngestWorker(
  concurrency = 1
): Worker<RepoIngestionJobData, RepoIngestionJobResult> {
  if (workerInstance) return workerInstance;

  workerInstance = new Worker<RepoIngestionJobData, RepoIngestionJobResult>(
    REPO_INGESTION_QUEUE_NAME,
    async (job: Job<RepoIngestionJobData, RepoIngestionJobResult>) => {
      const startTime = Date.now();
      const {
        repoId,
        repoName,
        repoRootPath,
        graphJsonPath,
        githubUrl,
        isEphemeralClone,
        resumeOnly,
        forceRestartSummary,
        options = {}
      } = job.data;

      console.log(`\n[Worker] ⚡ Picked up ingestion job ${job.id} for repo: "${repoName}" (${repoId}) [Resume: ${Boolean(resumeOnly)}]`);

      const updateProg = async (prog: JobProgress) => {
        await job.updateProgress(prog);
      };

      let activeRepoRoot = repoRootPath;
      const isEphemeral = Boolean(isEphemeralClone || githubUrl);
      let analyzerResult: AnalyzerPipelineResult;

      if (resumeOnly) {
        // ---------------------------------------------------------------------
        // RESUME / RESTART MODE: Load graph directly from PostgreSQL (Zero Clone)
        // ---------------------------------------------------------------------
        const repoExists = await pool.query("SELECT id FROM repositories WHERE id = $1", [repoId]);
        if (repoExists.rows.length === 0) {
          console.warn(`[Worker] 🛑 Repository "${repoId}" not found in database. Discarding job.`);
          throw new UnrecoverableError(`Repository ${repoId} does not exist in database.`);
        }
        await updateProg({
          stage: "parsing",
          percent: 15,
          message: "Step 2/5: Reconstructing dependency graph & topological levels from database...",
          detail: { phase: "Reconstructing DAG from PostgreSQL", stepIndex: 2, totalSteps: 5 }
        });

        if (forceRestartSummary) {
          console.log(`[Worker] [Restart] Resetting all function summaries for repo ${repoId}...`);
          await pool.query(
            `UPDATE code_nodes SET summary = 'pending_summary', embedding = NULL WHERE repo_id = $1`,
            [repoId]
          );
          await pool.query(
            `UPDATE repositories SET status = 'parsing', architecture_summary = NULL, onboarding_guide = NULL WHERE id = $1`,
            [repoId]
          );
        }

        console.log(`[Worker] [Resume] Reconstructing analyzer DAG from PostgreSQL for repo: ${repoId}`);
        analyzerResult = await RepositoryStore.reconstructAnalyzerResult(repoId);
      } else {
        // ---------------------------------------------------------------------
        // STAGE 0: Shallow Git Clone (if githubUrl provided)
        // ---------------------------------------------------------------------
        if (githubUrl) {
          await updateProg({
            stage: "cloning",
            percent: 5,
            message: `Step 1/5: Shallow-cloning repository from GitHub (${githubUrl})...`,
            detail: { phase: "Cloning GitHub repository", stepIndex: 1, totalSteps: 5 }
          });

          const tempCloneDir = path.resolve(process.cwd(), "tmp/clones", repoId);
          if (fs.existsSync(tempCloneDir)) {
            fs.rmSync(tempCloneDir, { recursive: true, force: true });
          }
          fs.mkdirSync(tempCloneDir, { recursive: true });

          console.log(`[Worker] [Clone] Cloning ${githubUrl} (depth 1) into ${tempCloneDir}...`);
          execSync(`git clone --depth 1 "${githubUrl}" "${tempCloneDir}"`, {
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 120000
          });

          activeRepoRoot = tempCloneDir;
        }

        // Ensure graph.json is present or auto-generated
        const activeGraphJsonPath = ensureGraphJson(activeRepoRoot, graphJsonPath);

        // ---------------------------------------------------------------------
        // STAGE 1: AST Extraction, Tarjan's SCC & Topological Sorting
        // ---------------------------------------------------------------------
        await updateProg({
          stage: "parsing",
          percent: 15,
          message: "Step 2/5: Extracting AST, call graph, and detecting cycles via Tarjan's SCC...",
          detail: { phase: "Extracting AST & Topological Sorting", stepIndex: 2, totalSteps: 5 }
        });

        console.log(`[Worker] [Stage 1] Parsing graph from: ${activeGraphJsonPath}`);
        analyzerResult = runAnalyzerPipeline({
          graphJsonPath: activeGraphJsonPath,
          repoRootPath: activeRepoRoot,
          filterCallablesOnly: options.filterCallablesOnly ?? true
        });

        // ---------------------------------------------------------------------
        // CHECKPOINT 1: Persist Graph Structure, Edges & Git Blame to DB
        // ---------------------------------------------------------------------
        const repoStillExists = await pool.query("SELECT id FROM repositories WHERE id = $1", [repoId]);
        if (repoStillExists.rows.length === 0) {
          console.warn(`[Worker] 🛑 Repository "${repoId}" was deleted during ingestion. Aborting immediately.`);
          if (isEphemeral && fs.existsSync(activeRepoRoot)) {
            try { fs.rmSync(activeRepoRoot, { recursive: true, force: true }); } catch {}
          }
          throw new UnrecoverableError(`Repository ${repoId} was deleted by user.`);
        }

        await updateProg({
          stage: "parsing",
          percent: 22,
          message: "Step 3/5: Checkpoint 1 — Persisting graph structure, call edges, and git blame to PostgreSQL...",
          detail: { phase: "Saving Checkpoint 1 to DB", stepIndex: 3, totalSteps: 5 }
        });

        console.log(`[Worker] [Checkpoint 1] Saving parsed structure and edges for "${repoName}" to PostgreSQL...`);
        await RepositoryStore.saveParsedStructure(
          repoId,
          repoName,
          activeRepoRoot,
          analyzerResult
        );

        // ---------------------------------------------------------------------
        // EPHEMERAL DISK CLEANUP: Delete cloned repo from disk immediately
        // ---------------------------------------------------------------------
        if (isEphemeral && fs.existsSync(activeRepoRoot)) {
          console.log(`[Worker] 🗑️ Deleting cloned repository from disk: ${activeRepoRoot}`);
          try {
            fs.rmSync(activeRepoRoot, { recursive: true, force: true });
            console.log(`[Worker] ✓ Cloned folder successfully deleted from disk. All assets safely in PostgreSQL.`);
          } catch (cleanupErr) {
            console.warn("[Worker] Warning: could not delete temporary clone directory:", cleanupErr);
          }
        }

        await updateProg({
          stage: "parsing",
          percent: 28,
          message: `Step 3/5 complete: ${analyzerResult.totalNodes} nodes, ${analyzerResult.totalEdges} edges saved. Disk clone removed.`,
          detail: { phase: "Checkpoint 1 complete", stepIndex: 3, totalSteps: 5 }
        });
      }

      // -----------------------------------------------------------------------
      // CHECKPOINT RESUMPTION CHECK: Check if any nodes were already summarized
      // -----------------------------------------------------------------------
      const existingSummaries = await RepositoryStore.getExistingSummaries(repoId);
      if (existingSummaries.size > 0) {
        console.log(`[Worker] 🔁 Found ${existingSummaries.size} existing summaries from previous checkpoint. Resuming without re-calling LLM...`);
      }

      // -----------------------------------------------------------------------
      // STAGE 2: Hierarchical Bottom-Up Gemini Summarization (Incremental Sub-Checkpoints)
      // -----------------------------------------------------------------------
      const repoCheckStage2 = await pool.query("SELECT id FROM repositories WHERE id = $1", [repoId]);
      if (repoCheckStage2.rows.length === 0) {
        console.warn(`[Worker] 🛑 Repository "${repoId}" was deleted before summarization. Aborting immediately.`);
        throw new UnrecoverableError(`Repository ${repoId} was deleted by user.`);
      }

      await updateProg({
        stage: "summarizing_functions",
        percent: 30,
        message: `Starting bottom-up function summarization (${existingSummaries.size}/${analyzerResult.totalNodes} already cached)...`
      });

      const gemini = new GeminiSummarizerClient({
        mockMode: options.mockMode
      });

      console.log(`[Worker] [Stage 2] Summarizing code hierarchically (Mock: ${gemini.isMockMode})...`);

      const summaryResult = await summarizeCodebaseHierarchically(analyzerResult, gemini, {
        repoName,
        repoRoot: repoRootPath,
        existingSummaries,
        chunkerOptions: {
          maxTokensPerBatch: options.maxTokensPerBatch ?? 24000
        },
        // Sub-checkpoint trigger: Save each batch directly to DB as it completes!
        onBatchCompleted: async (batchSummaries, currentLevel, totalLevels) => {
          // Check if repository was deleted by user while job was running
          const repoCheck = await pool.query("SELECT id FROM repositories WHERE id = $1", [repoId]);
          if (repoCheck.rows.length === 0) {
            console.warn(`[Worker] 🛑 Repository "${repoId}" was deleted. Aborting summarization.`);
            throw new UnrecoverableError(`Repository ${repoId} was deleted. Ingestion aborted.`);
          }

          const checkpointPercent = 30 + Math.round((currentLevel / totalLevels) * 40);
          await RepositoryStore.saveFunctionSummaryBatch(repoId, batchSummaries, {
            stage: "summarizing_functions",
            currentLevel,
            totalLevels,
            percent: checkpointPercent,
            updatedAt: new Date().toISOString()
          });

          await updateProg({
            stage: "summarizing_functions",
            percent: checkpointPercent,
            message: `Step 4/5: Summarizing functions (Level ${currentLevel} of ${totalLevels}) — ${batchSummaries.length} items committed to DB.`,
            detail: {
              phase: "Summarizing functions (bottom-up)",
              stepIndex: 4,
              totalSteps: 5,
              currentLevel,
              totalLevels
            }
          });
        },
        onProgress: async (stage, current, total) => {
          let percent = 30;
          let msg = "";

          if (stage === "functions") {
            percent = 30 + Math.round((current / total) * 40);
            msg = `Step 4/5: Summarizing functions — Level ${current} of ${total}`;
          } else if (stage === "files") {
            percent = 72 + Math.round((current / total) * 10);
            msg = `Step 4/5: Rolling up file contracts (${current}/${total} files)`;
          } else if (stage === "directories") {
            percent = 84 + Math.round((current / total) * 6);
            msg = `Step 4/5: Rolling up subsystem modules (${current}/${total} modules)`;
          }

          await updateProg({
            stage: `summarizing_${stage}` as JobProgress["stage"],
            percent,
            message: msg,
            detail: {
              phase: `Step 4/5: ${stage}`,
              stepIndex: 4,
              totalSteps: 5,
              count: current,
              totalCount: total
            }
          });
        }
      });

      // -----------------------------------------------------------------------
      // STAGE 3: Rollup Checkpoint (Files & Subsystems)
      // -----------------------------------------------------------------------
      const repoCheckRollup = await pool.query("SELECT id FROM repositories WHERE id = $1", [repoId]);
      if (repoCheckRollup.rows.length === 0) {
        console.warn(`[Worker] 🛑 Repository "${repoId}" was deleted before rollups. Aborting.`);
        throw new UnrecoverableError(`Repository ${repoId} was deleted. Ingestion aborted.`);
      }

      await updateProg({
        stage: "saving",
        percent: 92,
        message: "Step 5/5: Persisting file contracts & directory modules to PostgreSQL...",
        detail: { phase: "Finalizing Database Records", stepIndex: 5, totalSteps: 5 }
      });

      console.log(`[Worker] [Checkpoint 3] Saving file & directory rollups for "${repoName}" to PostgreSQL...`);
      await RepositoryStore.saveFileAndDirectoryRollups(
        repoId,
        summaryResult.files,
        summaryResult.directories
      );

      // -----------------------------------------------------------------------
      // STAGE 4: Final Checkpoint (Repository Architecture & Status Completed)
      // -----------------------------------------------------------------------
      await RepositoryStore.finalizeRepositorySummary(repoId, summaryResult.repo);

      const durationMs = Date.now() - startTime;

      const result: RepoIngestionJobResult = {
        repoId,
        repoName,
        status: "completed",
        totalNodes: analyzerResult.totalNodes,
        totalEdges: analyzerResult.totalEdges,
        topoLevels: analyzerResult.topoLevels.length,
        summaryResult,
        durationMs,
        completedAt: new Date().toISOString()
      };

      await updateProg({
        stage: "completed",
        percent: 100,
        message: `Successfully completed ingestion for ${repoName} in ${(durationMs / 1000).toFixed(2)}s.`
      });

      console.log(`[Worker] ✓ Job ${job.id} finished successfully in ${(durationMs / 1000).toFixed(2)}s!`);
      return result;
    },
    {
      connection: getRedisConnectionOptions(),
      concurrency,
      lockDuration: 60_000, // 60s baseline lock duration
      stalledInterval: 30_000 // Check for stalled jobs every 30s
    }
  );

  workerInstance.on("ready", () => {
    console.log(`[Worker] BullMQ worker ready and listening on queue: "${REPO_INGESTION_QUEUE_NAME}"`);
  });

  workerInstance.on("completed", (job) => {
    console.log(`[Worker] Job ${job.id} completed.`);
  });

  workerInstance.on("failed", (job, err) => {
    console.error(`[Worker] Job ${job?.id} failed with error:`, err);
  });

  workerInstance.on("error", (err) => {
    console.warn(`[Worker] Redis connection notice: ${err.message}`);
  });

  return workerInstance;
}

export async function closeIngestWorker(): Promise<void> {
  if (workerInstance) {
    await workerInstance.close();
    workerInstance = null;
  }
}
