import { Queue, Job } from "bullmq";
import { getRedisConnectionOptions } from "../../config/redis.js";
import type {
  RepoIngestionJobData,
  RepoIngestionJobResult,
  JobProgress
} from "../../core/types.js";

export const REPO_INGESTION_QUEUE_NAME = "repo-ingestion";

let queueInstance: Queue<RepoIngestionJobData, RepoIngestionJobResult> | null = null;

export function getRepoIngestionQueue(): Queue<
  RepoIngestionJobData,
  RepoIngestionJobResult
> {
  if (!queueInstance) {
    queueInstance = new Queue<RepoIngestionJobData, RepoIngestionJobResult>(
      REPO_INGESTION_QUEUE_NAME,
      {
        connection: getRedisConnectionOptions(),
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: "exponential",
            delay: 5000
          },
          removeOnComplete: {
            age: 3600,
            count: 200
          },
          removeOnFail: {
            age: 86400 * 3
          }
        }
      }
    );
  }
  return queueInstance;
}

export async function enqueueRepoIngestion(
  data: RepoIngestionJobData
): Promise<Job<RepoIngestionJobData, RepoIngestionJobResult>> {
  const queue = getRepoIngestionQueue();

  const job = await queue.add("ingest", data, {
    jobId: `repo_${data.repoId}_${Date.now()}`
  });

  return job;
}

export interface IngestionJobStatusResponse {
  jobId: string;
  state: "waiting" | "active" | "completed" | "failed" | "delayed" | "unknown";
  progress?: JobProgress;
  result?: RepoIngestionJobResult;
  failedReason?: string;
  timestamp?: number;
}

export async function getIngestionJobStatus(
  jobId: string
): Promise<IngestionJobStatusResponse | null> {
  const queue = getRepoIngestionQueue();
  const job = await queue.getJob(jobId);

  if (!job) return null;

  const state = await job.getState();
  const progress = (job.progress as JobProgress) || {
    stage: state === "active" ? "parsing" : "queued",
    percent: state === "completed" ? 100 : 0,
    message: state === "completed" ? "Completed" : "Queued"
  };

  return {
    jobId: String(job.id),
    state: state as IngestionJobStatusResponse["state"],
    progress,
    result: job.returnvalue,
    failedReason: job.failedReason,
    timestamp: job.timestamp
  };
}

export async function closeIngestQueue(): Promise<void> {
  if (queueInstance) {
    await queueInstance.close();
    queueInstance = null;
  }
}
