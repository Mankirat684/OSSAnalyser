import { pool } from "../../config/database.js";
import { RepositoryStore } from "../storage/index.js";
import { GeminiSummarizerClient } from "../summarizer/index.js";
import type { CopilotChatResponse } from "../../core/types.js";

const GENERIC_STOPWORDS = new Set([
  "which", "what", "where", "how", "why", "who", "when", "is", "are", "was", "were",
  "be", "been", "being", "have", "has", "had", "do", "does", "did", "can", "could",
  "should", "would", "will", "shall", "a", "an", "the", "and", "or", "but", "if",
  "because", "as", "of", "at", "by", "for", "with", "about", "to", "from", "in",
  "out", "on", "off", "over", "under", "all", "any", "both", "each", "more", "most",
  "other", "some", "such", "no", "nor", "not", "only", "own", "same", "so", "than",
  "too", "very", "just", "now", "responsible", "function", "functions", "file",
  "files", "code", "codebase", "implement", "implements", "implementation", "please",
  "tell", "me", "show", "find", "get", "give", "available", "method", "methods"
]);

const TRIVIAL_CONTROL_NAMES = new Set([
  "catch", "for", "filter", "while", "if", "finally", "switch", "Set", "caller"
]);

interface DenoisedQueryData {
  denoisedTerms: string[];
  subQueries: string[];
}

/**
 * Uses an LLM to denoise user input (stripping filler/generic programming noise)
 * and generate targeted search variations (Multi-Query Expansion).
 */
async function expandAndDenoiseQuery(
  question: string,
  gemini: GeminiSummarizerClient
): Promise<DenoisedQueryData> {
  const fallbackTerms = question
    .split(/\s+/)
    .map((w) => w.replace(/[^a-zA-Z0-9_]/g, "").toLowerCase())
    .filter((w) => w.length > 2 && !GENERIC_STOPWORDS.has(w));

  const fallback: DenoisedQueryData = {
    denoisedTerms: fallbackTerms.length > 0 ? fallbackTerms : [question.slice(0, 30)],
    subQueries: [question]
  };

  try {
    const prompt = `You are a search query optimizer for a software codebase search engine.
Analyze this developer question: "${question}"

1. Extract 3-6 domain-specific technical keywords (strip conversational filler and generic programming words like "which", "file", "function", "is", "responsible", "code", "in", "all", "available", "show", "where"). Keep core actions, UI components, data structures, and domain concepts.
2. Generate 2-3 specific search variations (e.g. one focused on UI/views, one focused on data provider/tree/storage, one focused on symbols/methods).

Respond strictly with valid JSON:
{
  "denoisedTerms": ["term1", "term2", "term3"],
  "subQueries": ["query variation 1", "query variation 2"]
}`;

    const jsonText = await gemini.generateText(prompt, () => JSON.stringify(fallback));
    const cleaned = jsonText.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    const validTerms =
      Array.isArray(parsed.denoisedTerms) && parsed.denoisedTerms.length > 0
        ? parsed.denoisedTerms
            .map((t: any) => String(t).trim().toLowerCase())
            .filter((t: string) => t.length > 2 && !GENERIC_STOPWORDS.has(t))
        : fallback.denoisedTerms;

    const validSubQueries =
      Array.isArray(parsed.subQueries) && parsed.subQueries.length > 0
        ? [question, ...parsed.subQueries.map((s: any) => String(s).trim()).filter((s: string) => s.length > 3)]
        : [question];

    return {
      denoisedTerms: validTerms.length > 0 ? validTerms : fallback.denoisedTerms,
      subQueries: Array.from(new Set(validSubQueries)).slice(0, 4)
    };
  } catch {
    return fallback;
  }
}

export class CodebaseCopilot {
  private gemini: GeminiSummarizerClient;

  constructor() {
    this.gemini = new GeminiSummarizerClient();
  }

  public async answerQuestion(
    repoId: string,
    question: string,
    history?: Array<{ role: string; content: string }>
  ): Promise<CopilotChatResponse> {
    const repoRes = await pool.query(
      `SELECT name, architecture_summary, onboarding_guide FROM repositories WHERE id = $1`,
      [repoId]
    );

    const repoInfo = repoRes.rows[0] || {
      name: "Codebase",
      architecture_summary: "Layered architecture",
      onboarding_guide: "Inspect components"
    };

    const allNodesRes = await pool.query(
      `SELECT id, name, file_path, node_type, summary, raw_code FROM code_nodes WHERE repo_id = $1`,
      [repoId]
    );
    const allNodes = allNodesRes.rows;
    const nodeMap = new Map<string, any>(allNodes.map((n) => [n.id, n]));

    // -------------------------------------------------------------------------
    // 1. Denoise Query & Generate Multi-Query Variations via LLM
    // -------------------------------------------------------------------------
    const { denoisedTerms, subQueries } = await expandAndDenoiseQuery(question, this.gemini);

    // -------------------------------------------------------------------------
    // 2. Multi-Query Vector Search via pgvector
    // -------------------------------------------------------------------------
    const vectorScores = new Map<string, number>();
    for (const q of subQueries) {
      try {
        const queryEmbedding = await this.gemini.generateEmbedding(q);
        const matches = await RepositoryStore.searchSimilarNodes(repoId, queryEmbedding, 8);
        for (const m of matches) {
          if (TRIVIAL_CONTROL_NAMES.has(m.name)) continue;
          const current = vectorScores.get(m.id) || 0;
          vectorScores.set(m.id, Math.max(current, m.similarity));
        }
      } catch (embErr) {
        console.warn(`[Copilot] Vector search warning for "${q}":`, embErr);
      }
    }

    // -------------------------------------------------------------------------
    // 3. Exact Symbol Matching (Excluding trivial control keywords)
    // -------------------------------------------------------------------------
    const exactMatches: any[] = [];
    for (const node of allNodes) {
      if (!node.name || node.name.length < 3) continue;
      if (TRIVIAL_CONTROL_NAMES.has(node.name)) continue;
      const escaped = node.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(`\\b${escaped}\\b`, "i");
      if (regex.test(question)) {
        exactMatches.push({ ...node, similarity: 1.0 });
      }
    }

    // -------------------------------------------------------------------------
    // 4. Multi-Term Keyword Matching with Denoised Tokens
    // -------------------------------------------------------------------------
    const keywordMatches = new Map<string, number>();
    if (denoisedTerms.length > 0) {
      const conditions = denoisedTerms.map(
        (_, idx) => `name ILIKE $${idx + 2} OR summary ILIKE $${idx + 2} OR file_path ILIKE $${idx + 2}`
      );
      const query = `
        SELECT id, name, file_path, node_type, summary, raw_code
        FROM code_nodes
        WHERE repo_id = $1 
          AND name NOT IN ('catch', 'for', 'filter', 'while', 'if', 'finally', 'switch', 'Set')
          AND (${conditions.join(" OR ")})
        LIMIT 15
      `;
      const params = [repoId, ...denoisedTerms.map((w) => `%${w}%`)];
      const res = await pool.query(query, params);
      for (const r of res.rows) {
        // Calculate matching keyword count for bonus scoring
        const fullText = `${r.name} ${r.file_path} ${r.summary || ""}`.toLowerCase();
        let matchCount = 0;
        for (const t of denoisedTerms) {
          if (fullText.includes(t)) matchCount++;
        }
        keywordMatches.set(r.id, Math.min(0.95, 0.70 + matchCount * 0.08));
      }
    }

    // -------------------------------------------------------------------------
    // 5. Merge candidates with Hybrid Confidence Scoring
    // -------------------------------------------------------------------------
    const CONFIDENCE_THRESHOLD = 0.35;
    const candidateMap = new Map<string, { node: any; score: number }>();

    for (const em of exactMatches) {
      candidateMap.set(em.id, { node: nodeMap.get(em.id) || em, score: 1.0 });
    }

    for (const [id, kwScore] of keywordMatches.entries()) {
      const existing = candidateMap.get(id);
      candidateMap.set(id, { node: nodeMap.get(id), score: Math.max(existing?.score || 0, kwScore) });
    }

    for (const [id, simScore] of vectorScores.entries()) {
      const existing = candidateMap.get(id);
      const node = nodeMap.get(id);
      if (!node) continue;

      // Count keyword overlaps for vector matches
      let kwBonus = 0;
      const fullText = `${node.name} ${node.file_path} ${node.summary || ""}`.toLowerCase();
      for (const t of denoisedTerms) {
        if (fullText.includes(t)) kwBonus += 0.05;
      }

      const combinedScore = Math.min(1.0, simScore + kwBonus);
      if (combinedScore >= CONFIDENCE_THRESHOLD) {
        candidateMap.set(id, { node, score: Math.max(existing?.score || 0, combinedScore) });
      }
    }

    // Sort by confidence score descending
    const sorted = Array.from(candidateMap.values())
      .filter((c) => c.node && !TRIVIAL_CONTROL_NAMES.has(c.node.name))
      .sort((a, b) => b.score - a.score);

    let matchedNodes = sorted.slice(0, 8).map((s) => s.node);

    // Fallback if empty
    if (matchedNodes.length === 0) {
      matchedNodes = allNodes
        .filter((n) => !TRIVIAL_CONTROL_NAMES.has(n.name))
        .slice(0, 5);
    }

    // -------------------------------------------------------------------------
    // 6. Direct Callers Enrichment for Top Confident Nodes
    // -------------------------------------------------------------------------
    const topNodeIds = matchedNodes.slice(0, 3).map((n) => n.id);
    const callersByTarget = new Map<string, Array<{ name: string; filePath: string; summary: string }>>();

    if (topNodeIds.length > 0) {
      const callersRes = await pool.query(
        `SELECT e.target_id, n.id, n.name, n.file_path, n.summary
         FROM code_edges e
         JOIN code_nodes n ON n.id = e.source_id AND n.repo_id = $1
         WHERE e.repo_id = $1 AND e.target_id = ANY($2::text[]) AND e.relation = 'calls'`,
        [repoId, topNodeIds]
      );

      for (const r of callersRes.rows) {
        const list = callersByTarget.get(r.target_id) || [];
        list.push({
          name: r.name,
          filePath: r.file_path,
          summary: r.summary || ""
        });
        callersByTarget.set(r.target_id, list);
      }
    }

    // Optional blast radius for impact queries
    let blastRadiusResults: any[] = [];
    const isImpactQuery =
      question.toLowerCase().includes("break") ||
      question.toLowerCase().includes("impact") ||
      question.toLowerCase().includes("change") ||
      question.toLowerCase().includes("touch") ||
      question.toLowerCase().includes("blast radius");

    if (isImpactQuery && matchedNodes.length > 0) {
      blastRadiusResults = await RepositoryStore.getBlastRadius(repoId, matchedNodes[0].id);
    }

    // Authorship
    const nodeIds = matchedNodes.map((n) => n.id);
    let ownershipRows: any[] = [];
    if (nodeIds.length > 0) {
      const ownerRes = await pool.query(
        `SELECT node_id, author_name, author_email, ownership_percentage, lines_authored, last_commit_date
         FROM git_ownership WHERE repo_id = $1 AND node_id = ANY($2::text[])`,
        [repoId, nodeIds]
      );
      ownershipRows = ownerRes.rows;
    }

    // -------------------------------------------------------------------------
    // 7. Context Assembly with Callers & Symbols
    // -------------------------------------------------------------------------
    const contextLines: string[] = [];
    contextLines.push(`Repository: ${repoInfo.name}`);
    contextLines.push(`Architecture: ${repoInfo.architecture_summary}`);
    contextLines.push(`Onboarding Guide: ${repoInfo.onboarding_guide}`);
    contextLines.push(`\nRelevant Code Symbols, Callers & Implementations:`);

    for (const node of matchedNodes) {
      contextLines.push(`\nSymbol: ${node.name} (${node.node_type})`);
      contextLines.push(`File: ${node.file_path}`);
      contextLines.push(`Summary: ${node.summary}`);

      // Inject Direct Callers for the top confident symbols
      const callers = callersByTarget.get(node.id) || [];
      if (callers.length > 0) {
        contextLines.push(`Direct Callers (Functions that invoke ${node.name}):`);
        for (const c of callers) {
          contextLines.push(`  - ${c.name}() in ${c.filePath}: ${c.summary}`);
        }
      }

      if (node.raw_code) {
        contextLines.push(`Source Code:\n\`\`\`\n${node.raw_code}\n\`\`\``);
      }

      const owners = ownershipRows.filter((o) => o.node_id === node.id);
      if (owners.length > 0) {
        contextLines.push(
          `Authorship / Ownership: ${owners.map((o) => `${o.author_name} (${o.ownership_percentage}%)`).join(", ")}`
        );
      }
    }

    if (blastRadiusResults.length > 0) {
      contextLines.push(`\nBlast Radius Analysis (Upstream affected functions if ${matchedNodes[0]?.name} is changed):`);
      for (const b of blastRadiusResults) {
        contextLines.push(`- Depth ${b.depth}: ${b.name} (${b.file_path}) -> ${b.summary}`);
      }
    }

    // Format the last 2 conversation turns if provided
    let conversationHistorySection = "";
    if (history && history.length > 0) {
      const recentHistory = history.slice(-4);
      conversationHistorySection =
        `\n--- Recent Conversation History (Last 2 Turns) ---\n` +
        recentHistory
          .map((h) => `${h.role === "user" ? "Developer" : "AI Assistant"}: ${h.content}`)
          .join("\n\n") +
        `\n----------------------------------------------------\n`;
    }

    const prompt = `You are a Principal Software Engineer and Staff Code Architect acting as an AI onboarding assistant.
A developer asked: "${question}"

Use the verified codebase context, direct callers, implementations, and conversation history below to provide an IN-DEPTH, THOROUGH, and technically rigorous answer.

--- Codebase Context ---
${contextLines.join("\n")}
------------------------
${conversationHistorySection}

Guidelines for your response:
1. Direct Identification: Explicitly name the exact file path, class/module, and specific functions/methods responsible.
2. Step-by-Step Technical Breakdown: Detail the architectural logic, data flow (e.g. database -> service -> UI/view), and how parameters/returns are handled.
3. Code Snippets: Include illustrative code snippets from the provided source code showing the core logic and how it works.
4. Upstream Integration & Callers: Detail how the function is invoked, where it is wired into the application lifecycle (e.g. in activation, registration, or handlers), and its direct callers.
5. Provide a rich, comprehensive markdown response that gives the engineer full clarity without being brief or superficial.`;

    const answerMarkdown = await this.gemini.generateText(prompt, () => {
      let fallbackText = `### Codebase Onboarding Insights\n\n`;
      fallbackText += `Regarding **"${question}"**:\n\n`;

      if (blastRadiusResults.length > 0) {
        fallbackText += `#### 💥 Blast Radius Impact\nModifying \`${matchedNodes[0]?.name}\` impacts the following upstream dependents:\n`;
        for (const b of blastRadiusResults) {
          fallbackText += `- **\`${b.name}\`** in \`${b.filePath}\` (Depth ${b.depth})\n`;
        }
        fallbackText += `\n`;
      }

      fallbackText += `#### 📌 Relevant Components & Callers\n`;
      for (const n of matchedNodes) {
        fallbackText += `- **\`${n.name}\`** (\`${n.file_path}\`): ${n.summary}\n`;
        const callers = callersByTarget.get(n.id) || [];
        if (callers.length > 0) {
          fallbackText += `  - *Direct Callers*: ${callers.map((c) => `\`${c.name}()\` in \`${c.filePath}\``).join(", ")}\n`;
        }
      }

      if (ownershipRows.length > 0) {
        fallbackText += `\n#### 👤 Ownership\n`;
        for (const o of ownershipRows) {
          fallbackText += `- **${o.author_name}** owns ${o.ownership_percentage}% of \`${o.node_id}\`.\n`;
        }
      }

      return fallbackText;
    });

    return {
      answer: answerMarkdown,
      referencedNodes: matchedNodes.map((n) => ({
        id: n.id,
        name: n.name,
        filePath: n.file_path,
        summary: n.summary
      })),
      blastRadius: blastRadiusResults.map((b) => ({
        id: b.id,
        name: b.name,
        filePath: b.filePath,
        depth: b.depth
      }))
    };
  }
}
