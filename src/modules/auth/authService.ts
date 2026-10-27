import * as crypto from "node:crypto";
import { pool } from "../../config/database.js";
import { getSupabaseClient, isSupabaseConfigured } from "../../config/supabase.js";
import type { AuthUser, ApiKeyRecord, AuthSession } from "../../core/types.js";

export class AuthService {
  /**
   * Registers a new user with email and password via Supabase Auth
   */
  public static async signUp(email: string, password: string): Promise<AuthSession> {
    const supabase = getSupabaseClient();

    if (supabase) {
      const { data, error } = await supabase.auth.signUp({
        email,
        password
      });

      if (error) {
        throw new Error(error.message);
      }

      if (!data.user) {
        throw new Error("User creation failed in Supabase");
      }

      return {
        accessToken: data.session?.access_token || "pending_email_verification",
        refreshToken: data.session?.refresh_token,
        expiresIn: data.session?.expires_in,
        user: {
          id: data.user.id,
          email: data.user.email,
          role: data.user.role,
          metadata: data.user.user_metadata
        }
      };
    }

    // Dev fallback when Supabase keys are not set
    const devUserId = `dev_usr_${crypto.createHash("md5").update(email).digest("hex").slice(0, 10)}`;
    const devToken = `dev_token_${crypto.randomBytes(16).toString("hex")}`;
    return {
      accessToken: devToken,
      user: {
        id: devUserId,
        email,
        role: "authenticated",
        metadata: { devMode: true }
      }
    };
  }

  /**
   * Signs in an existing user with email and password via Supabase Auth
   */
  public static async signIn(email: string, password: string): Promise<AuthSession> {
    const supabase = getSupabaseClient();

    if (supabase) {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password
      });

      if (error) {
        throw new Error(error.message);
      }

      if (!data.user || !data.session) {
        throw new Error("Invalid login response from Supabase");
      }

      return {
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        expiresIn: data.session.expires_in,
        user: {
          id: data.user.id,
          email: data.user.email,
          role: data.user.role,
          metadata: data.user.user_metadata
        }
      };
    }

    // Dev fallback
    const devUserId = `dev_usr_${crypto.createHash("md5").update(email).digest("hex").slice(0, 10)}`;
    const devToken = `dev_token_${crypto.randomBytes(16).toString("hex")}`;
    return {
      accessToken: devToken,
      user: {
        id: devUserId,
        email,
        role: "authenticated",
        metadata: { devMode: true }
      }
    };
  }

  /**
   * Verifies a Supabase access token (JWT)
   */
  public static async verifyToken(token: string): Promise<AuthUser | null> {
    if (!token) return null;

    // Check dev token
    if (token.startsWith("dev_token_")) {
      return {
        id: "dev_user_default",
        email: "developer@ossanalyser.local",
        role: "authenticated",
        metadata: { devMode: true }
      };
    }

    const supabase = getSupabaseClient();
    if (!supabase) {
      // In dev mode without Supabase, accept token as dev user
      return {
        id: "dev_user_default",
        email: "developer@ossanalyser.local",
        role: "authenticated",
        metadata: { devMode: true }
      };
    }

    try {
      const { data, error } = await supabase.auth.getUser(token);
      if (error || !data.user) {
        return null;
      }

      return {
        id: data.user.id,
        email: data.user.email,
        role: data.user.role,
        metadata: data.user.user_metadata
      };
    } catch {
      return null;
    }
  }

  /**
   * Creates a cryptographically secure API key for CLI, CI/CD, or AI Agent Harness
   */
  public static async createApiKey(
    userId: string,
    userEmail?: string,
    keyName = "Default API Key",
    expiresInDays?: number
  ): Promise<{ rawKey: string; keyRecord: ApiKeyRecord }> {
    const rawSecret = crypto.randomBytes(24).toString("hex");
    const rawKey = `oss_live_${rawSecret}`;
    const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
    const keyPrefix = rawKey.slice(0, 14) + "...";

    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 86400000).toISOString()
      : null;

    const res = await pool.query(
      `INSERT INTO api_keys (key_hash, key_prefix, user_id, user_email, name, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, key_prefix, user_id, user_email, name, created_at, last_used_at, expires_at`,
      [keyHash, keyPrefix, userId, userEmail || null, keyName, expiresAt]
    );

    const row = res.rows[0];
    const keyRecord: ApiKeyRecord = {
      id: String(row.id),
      keyPrefix: row.key_prefix,
      userId: row.user_id,
      userEmail: row.user_email || undefined,
      name: row.name,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at || undefined,
      expiresAt: row.expires_at || undefined
    };

    return { rawKey, keyRecord };
  }

  /**
   * Verifies an incoming API key (hashed in SHA-256)
   */
  public static async verifyApiKey(rawKey: string): Promise<AuthUser | null> {
    if (!rawKey || !rawKey.startsWith("oss_live_")) {
      return null;
    }

    const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");

    try {
      const res = await pool.query(
        `SELECT id, user_id, user_email, expires_at 
         FROM api_keys 
         WHERE key_hash = $1`,
        [keyHash]
      );

      if (res.rows.length === 0) {
        return null;
      }

      const row = res.rows[0];

      // Check expiration
      if (row.expires_at && new Date(row.expires_at) < new Date()) {
        return null;
      }

      // Update last_used_at asynchronously
      pool.query(`UPDATE api_keys SET last_used_at = NOW() WHERE id = $1`, [row.id]).catch(() => {});

      return {
        id: row.user_id,
        email: row.user_email || undefined,
        role: "authenticated",
        metadata: { apiKeyId: row.id }
      };
    } catch {
      return null;
    }
  }

  /**
   * Lists all active API keys for a user
   */
  public static async listApiKeys(userId: string): Promise<ApiKeyRecord[]> {
    const res = await pool.query(
      `SELECT id, key_prefix, user_id, user_email, name, created_at, last_used_at, expires_at
       FROM api_keys
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );

    return res.rows.map((row) => ({
      id: String(row.id),
      keyPrefix: row.key_prefix,
      userId: row.user_id,
      userEmail: row.user_email || undefined,
      name: row.name,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at || undefined,
      expiresAt: row.expires_at || undefined
    }));
  }

  /**
   * Revokes / deletes an API key
   */
  public static async revokeApiKey(userId: string, keyId: string): Promise<boolean> {
    const res = await pool.query(
      `DELETE FROM api_keys WHERE id = $1 AND user_id = $2`,
      [keyId, userId]
    );
    return (res.rowCount ?? 0) > 0;
  }
}
