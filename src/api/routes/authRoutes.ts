import { Router, type Request, type Response } from "express";
import { AuthService } from "../../modules/auth/index.js";
import { requireAuth } from "../middlewares/authMiddleware.js";

const router = Router();

/**
 * POST /api/auth/signup
 * Register a new user with email and password via Supabase
 */
router.post("/signup", async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }

  if (password.length < 6) {
    res.status(400).json({ error: "Password must be at least 6 characters" });
    return;
  }

  try {
    const session = await AuthService.signUp(email, password);
    res.status(201).json({
      message: "User registered successfully",
      session
    });
  } catch (err: any) {
    res.status(400).json({
      error: "Signup failed",
      message: err.message || "Failed to register user"
    });
  }
});

/**
 * POST /api/auth/login
 * Log in with email and password via Supabase
 */
router.post("/login", async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }

  try {
    const session = await AuthService.signIn(email, password);
    res.json({
      message: "Login successful",
      session
    });
  } catch (err: any) {
    res.status(401).json({
      error: "Login failed",
      message: err.message || "Invalid email or password"
    });
  }
});

/**
 * GET /api/auth/me
 * Get current authenticated user profile
 */
router.get("/me", requireAuth, async (req: Request, res: Response): Promise<void> => {
  res.json({
    user: req.user
  });
});

/**
 * POST /api/auth/api-keys
 * Generate a new API key for CLI, CI/CD, or AI coding agent harnesses
 */
router.post("/api-keys", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const userEmail = req.user!.email;
  const { name, expiresInDays } = req.body;

  try {
    const result = await AuthService.createApiKey(
      userId,
      userEmail,
      name || "CLI & Agent Key",
      expiresInDays ? parseInt(expiresInDays, 10) : undefined
    );

    res.status(201).json({
      message: "API key generated successfully. Save this key now; you will not be able to view it again.",
      apiKey: result.rawKey,
      record: result.keyRecord
    });
  } catch (err: any) {
    res.status(500).json({
      error: "Failed to generate API key",
      message: err.message || "Internal server error"
    });
  }
});

/**
 * GET /api/auth/api-keys
 * List active API keys for the current user
 */
router.get("/api-keys", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;

  try {
    const keys = await AuthService.listApiKeys(userId);
    res.json({ apiKeys: keys });
  } catch (err: any) {
    res.status(500).json({
      error: "Failed to list API keys",
      message: err.message || "Internal server error"
    });
  }
});

/**
 * DELETE /api/auth/api-keys/:id
 * Revoke an API key
 */
router.delete("/api-keys/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const keyId = String(req.params.id);

  try {
    const success = await AuthService.revokeApiKey(userId, keyId);
    if (!success) {
      res.status(404).json({ error: "API key not found or already deleted" });
      return;
    }
    res.json({ message: "API key revoked successfully" });
  } catch (err: any) {
    res.status(500).json({
      error: "Failed to revoke API key",
      message: err.message || "Internal server error"
    });
  }
});

export default router;
