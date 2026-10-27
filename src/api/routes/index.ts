import { Router } from "express";
import authRoutes from "./authRoutes.js";
import ingestRoutes from "./ingestRoutes.js";
import repoRoutes from "./repoRoutes.js";
import chatRoutes from "./chatRoutes.js";
import harnessRoutes from "./harnessRoutes.js";
import { optionalAuth, requireAuth } from "../middlewares/authMiddleware.js";
import { config } from "../../config/env.js";

const apiRouter = Router();

// Authentication & API Key management (signup/login are public; /me and /api-keys require auth)
apiRouter.use("/auth", authRoutes);

// Public server configuration endpoint (allows frontend UI to check hosted demo mode)
apiRouter.get("/repos/config", (_req, res) => {
  res.json({
    isHostedDemo: config.hostedDemo.isHostedDemo
  });
});

// Repositories: Public read access for everyone (listing, Cytoscape graph, AST nodes, blast radius)
// Write/Gemini operations (ingest, summarize, copilot chat) are strictly protected by hosted demo checks
apiRouter.use("/repos", optionalAuth, ingestRoutes);
apiRouter.use("/repos", optionalAuth, repoRoutes);
apiRouter.use("/repos", optionalAuth, chatRoutes);

// Coding Agent Harness endpoints (CLI/Agent execution) require authentication or API key
apiRouter.use("/harness", requireAuth, harnessRoutes);

export default apiRouter;
