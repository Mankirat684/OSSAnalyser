import { Router } from "express";
import authRoutes from "./authRoutes.js";
import ingestRoutes from "./ingestRoutes.js";
import repoRoutes from "./repoRoutes.js";
import chatRoutes from "./chatRoutes.js";
import harnessRoutes from "./harnessRoutes.js";
import { optionalAuth } from "../middlewares/authMiddleware.js";

const apiRouter = Router();

// Authentication & API Key management
apiRouter.use("/auth", authRoutes);

// Core repository operations (with optional or required user context)
apiRouter.use("/repos", optionalAuth, ingestRoutes);
apiRouter.use("/repos", optionalAuth, repoRoutes);
apiRouter.use("/repos", optionalAuth, chatRoutes);
apiRouter.use("/harness", optionalAuth, harnessRoutes);

export default apiRouter;
