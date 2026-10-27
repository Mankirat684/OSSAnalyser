import * as fs from "node:fs";
import * as path from "node:path";

export interface ToolResult {
  content: string;
  tokens: number;
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function listDirTool(repoRoot: string, dirPath?: string): ToolResult {
  try {
    const targetDir = path.resolve(repoRoot, dirPath || ".");
    if (!targetDir.startsWith(repoRoot)) {
      return { content: "Error: Access denied outside repository root.", tokens: 10 };
    }
    if (!fs.existsSync(targetDir)) {
      return { content: `Error: Directory not found: ${dirPath}`, tokens: 10 };
    }

    const entries = fs.readdirSync(targetDir, { withFileTypes: true });
    const formatted = entries
      .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "__pycache__")
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .slice(0, 50)
      .join("\n");

    return { content: formatted || "(empty directory)", tokens: estimateTokens(formatted) };
  } catch (err: any) {
    return { content: `Error: ${err.message}`, tokens: 10 };
  }
}

export function readFileTool(
  repoRoot: string,
  filePath: string,
  offset = 1,
  limit = 100
): ToolResult {
  try {
    const fullPath = path.resolve(repoRoot, filePath);
    if (!fullPath.startsWith(repoRoot)) {
      return { content: "Error: Access denied outside repository root.", tokens: 10 };
    }
    if (!fs.existsSync(fullPath)) {
      return { content: `Error: File not found: ${filePath}`, tokens: 10 };
    }

    const content = fs.readFileSync(fullPath, "utf-8");
    const lines = content.split(/\r?\n/);
    const startIdx = Math.max(0, offset - 1);
    const endIdx = Math.min(lines.length, startIdx + Math.min(limit, 200));

    const sliced = lines
      .slice(startIdx, endIdx)
      .map((line, idx) => `${startIdx + idx + 1}: ${line}`)
      .join("\n");

    const header = `[File: ${filePath} (lines ${startIdx + 1}-${endIdx} of ${lines.length})]\n`;
    const result = header + sliced;
    return { content: result, tokens: estimateTokens(result) };
  } catch (err: any) {
    return { content: `Error: ${err.message}`, tokens: 10 };
  }
}

export function grepTool(
  repoRoot: string,
  pattern: string,
  pathPrefix?: string
): ToolResult {
  try {
    const startDir = pathPrefix ? path.resolve(repoRoot, pathPrefix) : repoRoot;
    if (!startDir.startsWith(repoRoot) || !fs.existsSync(startDir)) {
      return { content: `Error: Path not found: ${pathPrefix}`, tokens: 10 };
    }

    const regex = new RegExp(pattern, "i");
    const matches: string[] = [];

    function walk(dir: string) {
      if (matches.length >= 30) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (matches.length >= 30) break;
        if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "__pycache__" || entry.name.endsWith(".sqlite") || entry.name.endsWith(".db")) {
          continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && (entry.name.endsWith(".py") || entry.name.endsWith(".ts") || entry.name.endsWith(".md"))) {
          try {
            const lines = fs.readFileSync(full, "utf-8").split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                const rel = path.relative(repoRoot, full).replace(/\\/g, "/");
                matches.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
                if (matches.length >= 30) break;
              }
            }
          } catch {
            // Ignore unreadable files
          }
        }
      }
    }

    walk(startDir);
    if (matches.length === 0) {
      return { content: `No matches found for pattern "${pattern}".`, tokens: 10 };
    }

    const result = `[Grep matches for "${pattern}"]: (showing ${matches.length} matches)\n` + matches.join("\n");
    return { content: result, tokens: estimateTokens(result) };
  } catch (err: any) {
    return { content: `Error: ${err.message}`, tokens: 10 };
  }
}
