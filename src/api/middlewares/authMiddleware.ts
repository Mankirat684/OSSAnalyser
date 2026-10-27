import type { Request, Response, NextFunction } from "express";
import { AuthService } from "../../modules/auth/index.js";
import { config } from "../../config/env.js";
import type { AuthUser } from "../../core/types.js";

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/**
 * Extracts and verifies auth token or API key from request
 */
async function authenticateRequest(req: Request): Promise<AuthUser | null> {
  // 1. Check X-API-Key header
  const apiKeyHeader = req.headers["x-api-key"] as string | undefined;
  if (apiKeyHeader) {
    const user = await AuthService.verifyApiKey(apiKeyHeader.trim());
    if (user) return user;
  }

  // 2. Check query param ?apiKey=
  const apiKeyQuery = req.query.apiKey as string | undefined;
  if (apiKeyQuery) {
    const user = await AuthService.verifyApiKey(apiKeyQuery.trim());
    if (user) return user;
  }

  // 3. Check Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7).trim();

    // Check if bearer token is an API key
    if (token.startsWith("oss_live_")) {
      const user = await AuthService.verifyApiKey(token);
      if (user) return user;
    }

    // Verify as Supabase JWT
    const user = await AuthService.verifyToken(token);
    if (user) return user;
  }

  return null;
}

/**
 * Middleware: Requires valid authentication (Supabase JWT or API Key)
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = await authenticateRequest(req);

  if (user) {
    req.user = user;
    return next();
  }

  // If strict auth is not required (e.g. local dev without keys), attach fallback
  if (!config.auth.requireAuth) {
    req.user = {
      id: "dev_user_default",
      email: "developer@ossanalyser.local",
      role: "authenticated",
      metadata: { devMode: true }
    };
    return next();
  }

  res.status(401).json({
    error: "Unauthorized",
    message: "Valid Supabase Bearer token or X-API-Key header is required"
  });
}

/**
 * Middleware: Optional authentication (attaches user if valid, continues otherwise)
 */
export async function optionalAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = await authenticateRequest(req);
  if (user) {
    req.user = user;
  } else if (!config.auth.requireAuth) {
    req.user = {
      id: "dev_user_default",
      email: "developer@ossanalyser.local",
      role: "authenticated"
    };
  }
  next();
}
