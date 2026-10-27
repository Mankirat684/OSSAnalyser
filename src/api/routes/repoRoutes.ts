import { Router, Request, Response } from "express";
import { pool } from "../../config/database.js";
import { config } from "../../config/env.js";
import { RepositoryStore } from "../../modules/storage/index.js";
import { enqueueRepoIngestion, getRepoIngestionQueue } from "../../modules/queue/index.js";

const router = Router();

function checkAdminAuthorization(req: Request): boolean {
  if (!config.hostedDemo.isHostedDemo) return true;
  const adminKey = (req.headers["x-admin-key"] as string) || req.body?.adminKey;
  const authHeader = req.headers.authorization;
  return Boolean(
    config.hostedDemo.adminIngestKey &&
    ((adminKey && adminKey === config.hostedDemo.adminIngestKey) ||
      (authHeader && authHeader.includes(config.hostedDemo.adminIngestKey)))
  );
}

/**
 * GET /api/repos
 * Retrieves all indexed repositories with live node and summary counts.
 */
router.get("/", async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT 
        r.id, 
        r.name, 
        r.root_path, 
        r.status, 
        r.checkpoint_data, 
        r.architecture_summary, 
        r.indexed_at,
        COUNT(n.id)::int as total_nodes,
        COUNT(CASE WHEN n.summary IS NOT NULL AND n.summary != 'pending_summary' THEN 1 END)::int as summarized_nodes
      FROM repositories r
      LEFT JOIN code_nodes n ON n.repo_id = r.id AND n.node_type IN ('function', 'class')
      GROUP BY r.id
      ORDER BY r.indexed_at DESC
    `);
    res.json(result.rows);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * DELETE /api/repos/:repoId
 * Deletes an ingested repository and all associated nodes, edges, and git blame.
 */
router.delete("/:repoId", async (req: Request, res: Response) => {
  if (!checkAdminAuthorization(req)) {
    return res.status(403).json({
      error: "Demo Mode Restricted",
      message: "Deleting repositories on this demo is restricted to the administrator."
    });
  }

  try {
    const repoId = String(req.params.repoId);

    // 1. Clean up any BullMQ jobs in Redis for this repo across all states
    try {
      const queue = getRepoIngestionQueue();
      const allJobs = await queue.getJobs(["waiting", "delayed", "active", "prioritized", "failed"]);
      for (const job of allJobs) {
        if (job.data?.repoId === repoId) {
          try { await job.remove(); } catch {}
        }
      }
    } catch (qErr) {
      console.warn("[repoRoutes] Notice cleaning up queue jobs:", qErr);
    }

    // 2. Delete from database (cascading deletes nodes, edges, and git blame)
    const deleteRes = await pool.query(
      "DELETE FROM repositories WHERE id = $1 RETURNING id, name",
      [repoId]
    );

    if (deleteRes.rowCount === 0) {
      return res.status(404).json({ error: `Repository ${repoId} not found.` });
    }

    res.json({
      success: true,
      message: `Repository "${deleteRes.rows[0].name}" (${repoId}) deleted successfully.`
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * POST /api/repos/:repoId/resume-summary
 * Resumes or restarts the LLM summarization pipeline directly from database records.
 */
router.post("/:repoId/resume-summary", async (req: Request, res: Response) => {
  if (!checkAdminAuthorization(req)) {
    return res.status(403).json({
      error: "Demo Mode Restricted",
      message: "Triggering summarization on this demo is restricted to the administrator."
    });
  }

  try {
    const repoId = String(req.params.repoId);
    const restart = Boolean(req.body.restart);

    const repoRes = await pool.query(
      "SELECT id, name, root_path, status, checkpoint_data FROM repositories WHERE id = $1",
      [repoId]
    );

    if (repoRes.rows.length === 0) {
      return res.status(404).json({ error: `Repository ${repoId} not found.` });
    }

    const repo = repoRes.rows[0];

    const job = await enqueueRepoIngestion({
      repoId: repo.id,
      repoName: repo.name,
      repoRootPath: repo.root_path,
      resumeOnly: true,
      forceRestartSummary: restart
    });

    res.status(202).json({
      success: true,
      jobId: job.id,
      repoId: repo.id,
      message: restart
        ? `Restarting summarization from scratch for ${repo.name}...`
        : `Resuming summarization from checkpoint for ${repo.name}...`
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/repos/:repoId/graph
 * Retrieves nodes and edges formatted for Cytoscape.js.
 */
router.get("/:repoId/graph", async (req: Request, res: Response) => {
  try {
    const repoId = String(req.params.repoId);
    const graphData = await RepositoryStore.getGraphElements(repoId);
    res.json(graphData);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/repos/:repoId/nodes/:nodeId
 * Retrieves full details for a node (code, summary, git blame, callers, callees, blast radius).
 */
router.get("/:repoId/nodes/:nodeId", async (req: Request, res: Response) => {
  try {
    const repoId = String(req.params.repoId);
    const nodeId = String(req.params.nodeId);
    const details = await RepositoryStore.getNodeDetails(repoId, nodeId);

    if (!details) {
      return res.status(404).json({ error: `Node ${nodeId} not found in repo ${repoId}.` });
    }

    res.json(details);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/repos/:repoId/blast-radius/:nodeId
 * Computes Blast Radius for a specific node using SQL Recursive CTE.
 */
router.get("/:repoId/blast-radius/:nodeId", async (req: Request, res: Response) => {
  try {
    const repoId = String(req.params.repoId);
    const nodeId = String(req.params.nodeId);
    const blastRadius = await RepositoryStore.getBlastRadius(repoId, nodeId);
    res.json({ targetNodeId: nodeId, blastRadius });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

export default router;
