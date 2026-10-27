import { Router, Request, Response } from "express";
import * as path from "node:path";
import * as fs from "node:fs";
import { pool } from "../../config/database.js";
import { enqueueRepoIngestion, getIngestionJobStatus } from "../../modules/queue/index.js";
import { config } from "../../config/env.js";

const router = Router();

/**
 * GET /api/repos/config
 * Returns public environment configuration (e.g. demo mode status).
 */
router.get("/config", (_req: Request, res: Response) => {
  res.json({
    isHostedDemo: config.hostedDemo.isHostedDemo
  });
});

/**
 * POST /api/repos/ingest
 * Enqueues a repository for asynchronous ingestion and summarization.
 */
router.post("/ingest", async (req: Request, res: Response) => {
  // Hosted Demo Mode: Only the administrator can ingest new repos to protect Gemini API quota
  if (config.hostedDemo.isHostedDemo) {
    const adminKey = (req.headers["x-admin-key"] as string) || req.body.adminKey;
    const authHeader = req.headers.authorization;
    const isAuthorized =
      Boolean(config.hostedDemo.adminIngestKey) &&
      ((adminKey && adminKey === config.hostedDemo.adminIngestKey) ||
        (authHeader && authHeader.includes(config.hostedDemo.adminIngestKey)));

    if (!isAuthorized) {
      return res.status(403).json({
        error: "Demo Mode Restricted",
        message:
          "Public Demo Notice: Ingestion on this hosted demo is restricted to the administrator to protect Gemini API quota. Feel free to explore the indexed repositories below, or clone the project and run locally via Docker to ingest any codebase!"
      });
    }
  }

  try {
    const {
      repoId = `repo_${Date.now()}`,
      repoName,
      repoRootPath,
      graphJsonPath,
      githubUrl,
      options
    } = req.body;

    if (!repoRootPath && !githubUrl) {
      return res.status(400).json({
        error: "Missing required field: either githubUrl or repoRootPath must be provided."
      });
    }

    let finalName = repoName;
    let finalRoot = repoRootPath ? path.resolve(repoRootPath) : "";
    let finalGraphPath = graphJsonPath ? path.resolve(graphJsonPath) : "";

    if (githubUrl) {
      const trimmedUrl = String(githubUrl).trim();
      if (!trimmedUrl.startsWith("http://") && !trimmedUrl.startsWith("https://")) {
        return res.status(400).json({ error: "Invalid GitHub URL format." });
      }

      if (!finalName) {
        const parts = trimmedUrl.replace(/\.git$/, "").split("/");
        finalName = parts[parts.length - 1] || "github-repo";
      }

      finalRoot = path.resolve(process.cwd(), "tmp/clones", repoId);
    } else {
      if (!finalName) {
        finalName = path.basename(finalRoot);
      }
    }

    // Pre-insert repository record with 'queued' status so it's trackable and deletable immediately
    await pool.query(
      `INSERT INTO repositories (id, name, root_path, status, checkpoint_data, indexed_at)
       VALUES ($1, $2, $3, 'queued', $4, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [repoId, finalName, finalRoot, JSON.stringify({ stage: "queued", enqueuedAt: new Date().toISOString() })]
    );

    const job = await enqueueRepoIngestion({
      repoId,
      repoName: finalName,
      repoRootPath: finalRoot,
      graphJsonPath: finalGraphPath || undefined,
      githubUrl: githubUrl ? String(githubUrl).trim() : undefined,
      isEphemeralClone: Boolean(githubUrl),
      options
    });

    res.status(202).json({
      success: true,
      jobId: job.id,
      repoId,
      message: `Ingestion job enqueued for ${finalName}.`
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/repos/jobs/:jobId
 * Polls the real-time status and progress of an ingestion job.
 */
router.get("/jobs/:jobId", async (req: Request, res: Response) => {
  try {
    const jobId = String(req.params.jobId);
    const status = await getIngestionJobStatus(jobId);

    if (!status) {
      return res.status(404).json({ error: `Job ${jobId} not found.` });
    }

    res.json(status);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

export default router;
