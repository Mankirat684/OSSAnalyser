import { Router, Request, Response } from "express";
import { pool } from "../../config/database.js";
import { CodebaseCopilot } from "../../modules/copilot/index.js";
import { config } from "../../config/env.js";

const router = Router();
const copilot = new CodebaseCopilot();

function checkAdminAuthorization(req: Request): boolean {
  if (!config.hostedDemo.isHostedDemo) return true;
  const adminKey = (req.headers["x-admin-key"] as string) || req.body?.adminKey;
  const authHeader = req.headers.authorization;
  return Boolean(
    config.hostedDemo.adminIngestKey &&
    ((adminKey && adminKey === config.hostedDemo.adminIngestKey) ||
      (authHeader && authHeader.includes(config.hostedDemo.adminIngestKey)))
  );
}

/**
 * GET /api/repos/:repoId/threads
 * Retrieves all saved chat threads for a repository, sorted by most recent.
 */
router.get("/:repoId/threads", async (req: Request, res: Response) => {
  try {
    const repoId = String(req.params.repoId);
    const result = await pool.query(
      `SELECT t.id, t.repo_id, t.title, t.created_at, t.updated_at,
              COUNT(m.id)::int as message_count
       FROM chat_threads t
       LEFT JOIN chat_messages m ON m.thread_id = t.id
       WHERE t.repo_id = $1
       GROUP BY t.id
       ORDER BY t.updated_at DESC`,
      [repoId]
    );
    res.json(result.rows);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * POST /api/repos/:repoId/threads
 * Creates a new chat thread for a repository.
 */
router.post("/:repoId/threads", async (req: Request, res: Response) => {
  try {
    const repoId = String(req.params.repoId);
    const title = (req.body.title || "New Conversation").trim().slice(0, 80);
    const threadId = `thread_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    const result = await pool.query(
      `INSERT INTO chat_threads (id, repo_id, title)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [threadId, repoId, title]
    );

    res.status(201).json(result.rows[0]);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/repos/:repoId/threads/:threadId/messages
 * Retrieves all messages in a specific chat thread.
 */
router.get("/:repoId/threads/:threadId/messages", async (req: Request, res: Response) => {
  try {
    const threadId = String(req.params.threadId);
    const threadRes = await pool.query(`SELECT * FROM chat_threads WHERE id = $1`, [threadId]);
    if (threadRes.rows.length === 0) {
      return res.status(404).json({ error: `Thread ${threadId} not found.` });
    }

    const messagesRes = await pool.query(
      `SELECT id, thread_id, role, content, referenced_nodes, blast_radius, created_at
       FROM chat_messages
       WHERE thread_id = $1
       ORDER BY id ASC`,
      [threadId]
    );

    res.json({
      thread: threadRes.rows[0],
      messages: messagesRes.rows
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * POST /api/repos/:repoId/threads/:threadId/messages
 * Sends a message in a thread, runs RAG with prior turn history, and persists the response.
 */
router.post("/:repoId/threads/:threadId/messages", async (req: Request, res: Response) => {
  // Demo Mode: Block Gemini API calls for unauthenticated/demo visitors
  if (config.hostedDemo.isHostedDemo && !checkAdminAuthorization(req)) {
    return res.status(403).json({
      error: "Copilot Disabled in Demo Mode",
      message:
        "AI Copilot queries are disabled on this hosted demo to protect Gemini API quota. Feel free to explore the interactive code graph, AST relationships, contract summaries, and blast radius calculations!"
    });
  }

  try {
    const repoId = String(req.params.repoId);
    const threadId = String(req.params.threadId);
    const rawInput = req.body.question || req.body.message;
    const question = typeof rawInput === "string" ? rawInput.trim() : "";

    if (!question) {
      return res.status(400).json({ error: "Missing required parameter: question" });
    }

    // Verify thread exists or auto-create it
    let threadRes = await pool.query(`SELECT * FROM chat_threads WHERE id = $1`, [threadId]);
    if (threadRes.rows.length === 0) {
      const autoTitle = question.trim().replace(/[\r\n]+/g, " ").slice(0, 45);
      threadRes = await pool.query(
        `INSERT INTO chat_threads (id, repo_id, title)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [threadId, repoId, autoTitle]
      );
    }
    const thread = threadRes.rows[0];

    // Fetch the last 4 messages (last 2 conversation turns) to provide multi-turn context
    const historyRes = await pool.query(
      `SELECT role, content
       FROM chat_messages
       WHERE thread_id = $1
       ORDER BY id DESC
       LIMIT 4`,
      [threadId]
    );
    const history = historyRes.rows.reverse();

    // 1. Insert user message into database
    await pool.query(
      `INSERT INTO chat_messages (thread_id, role, content)
       VALUES ($1, 'user', $2)`,
      [threadId, question.trim()]
    );

    // 2. Execute Graph-Augmented RAG
    const answer = await copilot.answerQuestion(repoId, question.trim(), history);

    // 3. Insert assistant response into database
    const assistantMsgRes = await pool.query(
      `INSERT INTO chat_messages (thread_id, role, content, referenced_nodes, blast_radius)
       VALUES ($1, 'assistant', $2, $3, $4)
       RETURNING *`,
      [
        threadId,
        answer.answer,
        JSON.stringify(answer.referencedNodes || []),
        JSON.stringify(answer.blastRadius || [])
      ]
    );

    // 4. Update thread title if still generic
    if (thread.title === "New Conversation" || thread.title === "Untitled Chat") {
      const autoTitle = question.trim().replace(/[\r\n]+/g, " ").slice(0, 45);
      await pool.query(
        `UPDATE chat_threads SET title = $1, updated_at = NOW() WHERE id = $2`,
        [autoTitle, threadId]
      );
    } else {
      await pool.query(`UPDATE chat_threads SET updated_at = NOW() WHERE id = $1`, [threadId]);
    }

    res.json({
      message: assistantMsgRes.rows[0],
      answer: answer.answer,
      referencedNodes: answer.referencedNodes,
      blastRadius: answer.blastRadius
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * DELETE /api/repos/:repoId/threads/:threadId
 * Deletes a chat thread and all associated messages.
 */
router.delete("/:repoId/threads/:threadId", async (req: Request, res: Response) => {
  try {
    const threadId = String(req.params.threadId);
    const deleteRes = await pool.query(
      `DELETE FROM chat_threads WHERE id = $1 RETURNING id`,
      [threadId]
    );
    if (deleteRes.rowCount === 0) {
      return res.status(404).json({ error: `Thread ${threadId} not found.` });
    }
    res.json({ success: true, threadId });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * Backwards-compatible POST /api/repos/:repoId/chat
 */
router.post("/:repoId/chat", async (req: Request, res: Response) => {
  // Demo Mode: Block Gemini API calls for unauthenticated/demo visitors
  if (config.hostedDemo.isHostedDemo && !checkAdminAuthorization(req)) {
    return res.status(403).json({
      error: "Copilot Disabled in Demo Mode",
      message:
        "AI Copilot queries are disabled on this hosted demo to protect Gemini API quota. Feel free to explore the interactive code graph, AST relationships, contract summaries, and blast radius calculations!"
    });
  }

  try {
    const repoId = String(req.params.repoId);
    const { question, history } = req.body;

    if (!question) {
      return res.status(400).json({ error: "Missing required parameter: question" });
    }

    const answer = await copilot.answerQuestion(repoId, question, history);
    res.json(answer);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

export default router;
