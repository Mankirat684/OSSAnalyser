import type { ConnectionOptions } from "bullmq";
import { config } from "./env.js";

export function getRedisConnectionOptions(): ConnectionOptions {
  // Upstash or connection-string based Redis
  if (config.redis.url) {
    const isUpstashOrTls =
      config.redis.url.startsWith("rediss://") ||
      config.redis.url.includes("upstash.io") ||
      config.redis.tls;

    return {
      url: config.redis.url,
      tls: isUpstashOrTls ? { rejectUnauthorized: false } : undefined,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      retryStrategy: (times: number) => Math.min(times * 200, 3000)
    };
  }

  // Standard host/port configuration (local or Upstash host parameters)
  const isTls = config.redis.tls || config.redis.host.includes("upstash.io");

  return {
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    tls: isTls ? { rejectUnauthorized: false } : undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: (times: number) => Math.min(times * 200, 3000)
  };
}
