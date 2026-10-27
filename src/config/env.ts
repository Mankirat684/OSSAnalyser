import * as dotenv from "dotenv";

dotenv.config({ quiet: true });

export const config = {
  server: {
    port: parseInt(process.env.PORT || "4000", 10),
    env: process.env.NODE_ENV || "development"
  },
  database: {
    url:
      process.env.DATABASE_URL ||
      "postgresql://postgres:postgrespassword@localhost:5432/ossanalyser",
    ssl: process.env.DATABASE_SSL === "true"
  },
  redis: {
    url: process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL || "",
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: parseInt(process.env.REDIS_PORT || "6379", 10),
    password: process.env.REDIS_PASSWORD || undefined,
    tls: process.env.REDIS_TLS === "true"
  },
  supabase: {
    url: process.env.SUPABASE_URL || "",
    anonKey: process.env.SUPABASE_ANON_KEY || "",
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || ""
  },
  auth: {
    requireAuth: process.env.REQUIRE_AUTH === "true"
  },
  hostedDemo: {
    isHostedDemo: process.env.IS_HOSTED_DEMO === "true",
    adminIngestKey: process.env.ADMIN_INGEST_KEY || ""
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || "",
    modelName: process.env.GEMINI_MODEL || "gemini-3.5-flash-lite"
  }
} as const;
