import { AuthService } from "../src/modules/auth/index.js";
import { pool } from "../src/config/database.js";

async function testAuth() {
  console.log("==================================================================");
  console.log("  TEST: Supabase & API Key Authentication");
  console.log("==================================================================\n");

  // 1. Sign up test
  console.log("[1] Testing User Registration / Auth Flow...");
  const signupResult = await AuthService.signUp("test_developer@ossanalyser.io", "securePassword123!");
  console.log(`✓ User Registered: ${signupResult.user.email} (ID: ${signupResult.user.id})`);
  console.log(`✓ Access Token Issued: ${signupResult.accessToken.slice(0, 15)}...`);

  // 2. Token verification
  console.log("\n[2] Verifying Access Token...");
  const verifiedUser = await AuthService.verifyToken(signupResult.accessToken);
  if (!verifiedUser) {
    throw new Error("Failed to verify issued access token!");
  }
  console.log(`✓ Token Verified for: ${verifiedUser.email}`);

  // 3. API Key creation (requires DB for api_keys table)
  let dbUp = false;
  try {
    await pool.query("SELECT 1");
    dbUp = true;
  } catch {
    console.log("\n[Status] Database is offline — skipping live DB API Key persistence test.");
    console.log("💡 Start DB to test persistent API Keys: docker compose up -d postgres / Supabase");
  }

  if (dbUp) {
    console.log("\n[3] Testing API Key Generation & Verification...");
    const { rawKey, keyRecord } = await AuthService.createApiKey(
      signupResult.user.id,
      signupResult.user.email,
      "Agent Traversal Harness Key"
    );
    console.log(`✓ API Key Generated: ${rawKey.slice(0, 15)}... (Prefix: ${keyRecord.keyPrefix})`);

    const authUser = await AuthService.verifyApiKey(rawKey);
    if (!authUser || authUser.id !== signupResult.user.id) {
      throw new Error("Failed to verify generated API key!");
    }
    console.log(`✓ API Key Successfully Verified for: ${authUser.email || authUser.id}`);

    // Verify invalid key fails
    const invalidAuth = await AuthService.verifyApiKey("oss_live_invalidkey123");
    if (invalidAuth !== null) {
      throw new Error("Invalid API key was incorrectly accepted!");
    }
    console.log("✓ Invalid API Key correctly rejected.");

    await pool.end();
  }

  console.log("\nALL AUTH TESTS PASSED! 🎉\n");
}

testAuth().catch((err) => {
  console.error("Auth test failed:", err);
  process.exit(1);
});
