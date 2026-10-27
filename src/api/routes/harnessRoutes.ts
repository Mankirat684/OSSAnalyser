import { Router, Request, Response } from "express";
import { CodebaseHarness } from "../../interfaces/harness/index.js";

const router = Router();
const harness = new CodebaseHarness();

/**
 * GET /api/harness/:repoId/architecture
 * Compact architecture overview (~150 tokens).
 */
router.get("/:repoId/architecture", async (req: Request, res: Response) => {
  try {
    const repoId = String(req.params.repoId);
    const data = await harness.getArchitectureOverview(repoId);
    res.json(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/harness/:repoId/file
 * Compact file contract without raw code (~80 tokens).
 */
router.get("/:repoId/file", async (req: Request, res: Response) => {
  try {
    const repoId = String(req.params.repoId);
    const filePath = String(req.query.path || "");

    if (!filePath) {
      return res.status(400).json({ error: "Missing query parameter: path" });
    }

    const data = await harness.getFileContract(repoId, filePath);
    if (!data) {
      return res.status(404).json({ error: `File ${filePath} not found.` });
    }

    res.json(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/harness/:repoId/symbol/:symbol
 * Compact function/method contract (~40 tokens).
 */
router.get("/:repoId/symbol/:symbol", async (req: Request, res: Response) => {
  try {
    const repoId = String(req.params.repoId);
    const symbol = String(req.params.symbol);
    const data = await harness.getFunctionContract(repoId, symbol);

    if (!data) {
      return res.status(404).json({ error: `Symbol ${symbol} not found.` });
    }

    res.json(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/harness/:repoId/blast-radius/:symbol
 * Blast radius impact before making code modifications (~50 tokens).
 */
router.get("/:repoId/blast-radius/:symbol", async (req: Request, res: Response) => {
  try {
    const repoId = String(req.params.repoId);
    const symbol = String(req.params.symbol);
    const data = await harness.getBlastRadius(repoId, symbol);
    res.json(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * POST /api/harness/:repoId/context
 * Resolves minimal task context within strict token budgets.
 */
router.post("/:repoId/context", async (req: Request, res: Response) => {
  try {
    const repoId = String(req.params.repoId);
    const { task, budget = 2500 } = req.body;

    if (!task) {
      return res.status(400).json({ error: "Missing required parameter: task" });
    }

    const context = await harness.resolveMinimalContext(repoId, task, Number(budget));
    res.json(context);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/harness/mcp-tools
 * Model Context Protocol tool schema definitions.
 */
router.get("/mcp-tools", (_req: Request, res: Response) => {
  res.json(harness.getMCPToolDefinitions());
});

export default router;
