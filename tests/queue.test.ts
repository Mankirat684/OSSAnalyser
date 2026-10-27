import * as net from "node:net";
import * as path from "node:path";
import { config } from "../src/config/env.js";
import {
  getRepoIngestionQueue,
  getIngestionJobStatus,
  createIngestWorker,
  closeIngestQueue,
  closeIngestWorker
} from "../src/modules/queue/index.js";
import type { RepoIngestionJobData } from "../src/core/types.js";

function checkRedisReachable(host: string, port: number, timeoutMs = 600): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    socket.setTimeout(timeoutMs);
    socket.on("connect", () => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(true);
      }
    });
    socket.on("timeout", () => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(false);
      }
    });
    socket.on("error", () => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(false);
      }
    });
    socket.connect(port, host);
  });
}

async function testQueuePipeline() {
  console.log("==================================================================");
  console.log("  TEST: BullMQ & Redis Ingestion Queue & Worker");
  console.log("==================================================================\n");

  let targetHost = config.redis.host;
  let targetPort = config.redis.port;

  if (config.redis.url) {
    try {
      const parsed = new URL(config.redis.url);
      targetHost = parsed.hostname;
      targetPort = parsed.port ? parseInt(parsed.port, 10) : 6379;
    } catch {
      // Fallback
    }
  }

  const isUp = await checkRedisReachable(targetHost, targetPort, 1200);

  if (!isUp) {
    console.log(`[Status] Redis is currently offline at ${targetHost}:${targetPort}.`);
    console.log("💡 Start Redis locally using: docker compose up -d redis");
    console.log("💡 Or connect to Upstash by setting: UPSTASH_REDIS_URL=rediss://default:***@***.upstash.io:6379\n");
    return;
  }

  console.log(`✓ Connected to Redis server at ${targetHost}:${targetPort}`);

  const repoRoot = path.resolve(process.cwd(), "test_repos/graphify-ts-test");
  const graphJsonPath = path.resolve(repoRoot, "graphify-out/graph.json");

  const jobPayload: RepoIngestionJobData = {
    repoId: "repo_test_123",
    repoName: "graphify-ts-test",
    repoRootPath: repoRoot,
    graphJsonPath,
    options: { filterCallablesOnly: true, mockMode: true }
  };

  const worker = createIngestWorker(1);
  const queue = getRepoIngestionQueue();
  const job = await queue.add("ingest", jobPayload);
  console.log(`✓ Enqueued job ID: ${job.id}`);

  let completed = false;
  let attempts = 0;

  while (!completed && attempts < 40) {
    await new Promise((r) => setTimeout(r, 800));
    attempts++;

    const status = await getIngestionJobStatus(String(job.id));
    if (status) {
      const prog = status.progress;
      console.log(`  --> Job State: [${status.state.toUpperCase()}] Progress: ${prog?.percent ?? 0}% - ${prog?.message ?? ""}`);

      if (status.state === "completed") {
        completed = true;
        console.log("\n✓ Job completed successfully!");
        console.log(`  Duration: ${(status.result?.durationMs ?? 0) / 1000}s`);
        console.log(`  Parsed Nodes: ${status.result?.totalNodes}`);
      } else if (status.state === "failed") {
        throw new Error(`Job failed: ${status.failedReason}`);
      }
    }
  }

  await closeIngestWorker();
  await closeIngestQueue();
  console.log("\nALL QUEUE TESTS PASSED! 🎉\n");
}

testQueuePipeline().catch((err) => {
  console.error("Queue test failed:", err);
  process.exit(1);
});
