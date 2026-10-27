import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { config } from "./env.js";
import * as schema from "../modules/storage/schema.js";

const { Pool } = pg;

// Supabase and hosted PostgreSQL require SSL
const isRemoteSupabaseOrSsl =
  config.database.ssl ||
  config.database.url.includes("supabase.co") ||
  config.database.url.includes("supabase.com") ||
  config.database.url.includes("pooler.supabase.com") ||
  config.database.url.includes("sslmode=require");

export const pool = new Pool({
  connectionString: config.database.url,
  ssl: isRemoteSupabaseOrSsl
    ? {
        rejectUnauthorized: false
      }
    : undefined
});

pool.on("error", (err) => {
  console.error("[PostgreSQL Pool Error]", err);
});

// Drizzle ORM client initialized on the existing connection pool
export const db = drizzle(pool, { schema });

