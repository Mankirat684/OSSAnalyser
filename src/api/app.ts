import express, { Express } from "express";
import cors from "cors";
import * as path from "node:path";
import apiRouter from "./routes/index.js";
import { errorHandler } from "./middlewares/errorHandler.js";

export function createApp(): Express {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Mount API router
  app.use("/api", apiRouter);

  // Serve static UI assets
  const publicDir = path.resolve(process.cwd(), "public");
  app.use(express.static(publicDir));

  // Global error handler
  app.use(errorHandler);

  return app;
}
