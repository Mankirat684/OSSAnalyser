import { createApp } from "./api/app.js";
import { config } from "./config/env.js";
import { createIngestWorker } from "./modules/queue/index.js";
import { initializeDatabase } from "./modules/storage/initDb.js";

async function bootstrap() {
  // Auto-initialize PostgreSQL schema if database is reachable
  try {
    await initializeDatabase();
  } catch (err: any) {
    console.warn("[DB Auto-Init] PostgreSQL schema check deferred:", err?.message || err);
  }

  const app = createApp();

  // Start background queue worker if Redis is configured or running locally
  if (config.redis.url || !config.hostedDemo.isHostedDemo) {
    try {
      createIngestWorker(1);
    } catch (err: any) {
      console.warn("[Worker] Ingestion queue worker skipped:", err?.message || err);
    }
  } else {
    console.log("ℹ️  Ingestion Worker paused (Running in read-only demo mode without Redis)");
  }

  app.listen(config.server.port, () => {
    console.log(`\n🚀 OSS Analyser running on http://localhost:${config.server.port}`);
    console.log(`📡 Ingestion Worker listening on BullMQ queue: "repo-ingestion"\n`);
  });
}

bootstrap().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
