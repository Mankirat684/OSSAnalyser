import { execSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import type { AuthorOwnership } from "../../core/types.js";

export interface LineBlameInfo {
  lineNumber: number;
  commit: string;
  author: string;
  email: string;
  time: string;
}

export type FileBlameMap = Map<number, LineBlameInfo>;
export type GitBlameCache = Map<string, FileBlameMap>;

/**
 * Extracts line-by-line git blame for an entire file once and caches it in memory.
 */
export function getFileBlame(
  repoRoot: string,
  relativeFilePath: string,
  cache?: GitBlameCache
): FileBlameMap {
  if (cache && cache.has(relativeFilePath)) {
    return cache.get(relativeFilePath)!;
  }

  const fullPath = path.resolve(repoRoot, relativeFilePath);
  const blameMap: FileBlameMap = new Map();

  if (!fs.existsSync(fullPath)) {
    if (cache) cache.set(relativeFilePath, blameMap);
    return blameMap;
  }

  try {
    const cmd = `git blame -w -C --line-porcelain "${relativeFilePath}"`;
    const output = execSync(cmd, {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 50 * 1024 * 1024 // 50MB buffer for large files
    });

    const lines = output.split(/\r?\n/);
    let currentCommit = "";
    let currentAuthor = "";
    let currentEmail = "";
    let currentTime = "";
    let currentLineNumber = 0;

    for (const line of lines) {
      if (line.match(/^[0-9a-f]{40}\s/)) {
        const parts = line.split(" ");
        currentCommit = parts[0];
        const parsedLine = parseInt(parts[2], 10);
        if (!isNaN(parsedLine)) {
          currentLineNumber = parsedLine;
        } else {
          currentLineNumber++;
        }
      } else if (line.startsWith("author ")) {
        currentAuthor = line.substring(7).trim();
      } else if (line.startsWith("author-mail ")) {
        currentEmail = line.substring(12).replace(/[<>]/g, "").trim();
      } else if (line.startsWith("author-time ")) {
        const timestamp = parseInt(line.substring(12).trim(), 10) * 1000;
        currentTime = new Date(timestamp).toISOString();
      } else if (line.startsWith("\t")) {
        if (currentLineNumber > 0 && currentAuthor) {
          blameMap.set(currentLineNumber, {
            lineNumber: currentLineNumber,
            commit: currentCommit,
            author: currentAuthor,
            email: currentEmail || "unknown@domain.com",
            time: currentTime || new Date().toISOString()
          });
        }
      }
    }
  } catch {
    // Return empty blameMap on failure (extractOwnershipFromBlameMap provides fallback)
  }

  if (cache) {
    cache.set(relativeFilePath, blameMap);
  }
  return blameMap;
}

/**
 * Calculates author ownership percentages for a line range using a pre-parsed FileBlameMap.
 * Zero sub-processes spawned; pure in-memory slice.
 */
export function extractOwnershipFromBlameMap(
  fileBlame: FileBlameMap,
  startLine?: number,
  endLine?: number
): AuthorOwnership[] {
  const start = startLine && startLine > 0 ? startLine : 1;
  const end = endLine && endLine >= start ? endLine : start + 10;

  const authorLineCounts = new Map<string, number>();
  const authorEmails = new Map<string, string>();
  const authorDates = new Map<string, string>();
  const authorCommits = new Map<string, Set<string>>();

  let totalLines = 0;

  for (let l = start; l <= end; l++) {
    const lineInfo = fileBlame.get(l);
    if (!lineInfo || !lineInfo.author) continue;

    totalLines++;
    const { author, email, time, commit } = lineInfo;

    authorLineCounts.set(author, (authorLineCounts.get(author) || 0) + 1);
    authorEmails.set(author, email);

    const existingDate = authorDates.get(author);
    if (!existingDate || new Date(time) > new Date(existingDate)) {
      authorDates.set(author, time);
    }

    if (!authorCommits.has(author)) {
      authorCommits.set(author, new Set());
    }
    authorCommits.get(author)!.add(commit);
  }

  if (totalLines === 0) {
    return [
      {
        authorName: "Primary Contributor",
        authorEmail: "contributor@domain.com",
        linesAuthored: Math.max(1, end - start + 1),
        ownershipPercentage: 100,
        lastCommitDate: new Date().toISOString(),
        totalCommits: 1
      }
    ];
  }

  const result: AuthorOwnership[] = [];
  for (const [author, count] of authorLineCounts.entries()) {
    result.push({
      authorName: author,
      authorEmail: authorEmails.get(author) || "unknown@domain.com",
      linesAuthored: count,
      ownershipPercentage: Math.round((count / totalLines) * 1000) / 10,
      lastCommitDate: authorDates.get(author) || new Date().toISOString(),
      totalCommits: authorCommits.get(author)?.size || 1
    });
  }

  return result.sort((a, b) => b.ownershipPercentage - a.ownershipPercentage);
}

/**
 * Extracts git blame authorship stats for a file and line range.
 * If a cache is provided, reuses cached whole-file blame without spawning extra processes.
 */
export function extractGitOwnershipForRange(
  repoRoot: string,
  relativeFilePath: string,
  startLine?: number,
  endLine?: number,
  cache?: GitBlameCache
): AuthorOwnership[] {
  const fileBlame = getFileBlame(repoRoot, relativeFilePath, cache);
  return extractOwnershipFromBlameMap(fileBlame, startLine, endLine);
}
