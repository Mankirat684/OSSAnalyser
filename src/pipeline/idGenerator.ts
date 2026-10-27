import * as crypto from "node:crypto";

/**
 * Deterministic node ID generator adhering to Section 3.2 of the spec.
 * - Symbols: first 12 hex chars of sha1(rel_path + '::' + qualified_name + '::' + node_type)
 *   Appends `#n` on overload / duplicate collisions.
 * - Files: file_${relPath.replace(/[^a-zA-Z0-9_]/g, '_')}
 * - Directories / modules: dir_${relPath.replace(/[^a-zA-Z0-9_]/g, '_')}
 */

export function normalizeRelPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

export class NodeIdGenerator {
  private seenCounts = new Map<string, number>();

  public reset(): void {
    this.seenCounts.clear();
  }

  public makeNodeId(
    relPath: string,
    nameOrQName: string,
    nodeType: "function" | "method" | "class" | "file" | "module" | "directory"
  ): string {
    const normPath = normalizeRelPath(relPath);

    if (nodeType === "file") {
      return `file_${normPath.replace(/[^a-zA-Z0-9_]/g, "_")}`;
    }

    if (nodeType === "directory" || nodeType === "module") {
      return `dir_${normPath.replace(/[^a-zA-Z0-9_]/g, "_")}`;
    }

    // Symbol node
    const rawKey = `${normPath}::${nameOrQName}::${nodeType}`;
    const hash12 = crypto.createHash("sha1").update(rawKey).digest("hex").slice(0, 12);

    const count = this.seenCounts.get(hash12) || 0;
    this.seenCounts.set(hash12, count + 1);

    if (count > 0) {
      return `${hash12}#${count}`;
    }

    return hash12;
  }
}

export function makeCoordinateDisplayId(
  filePath: string,
  symbolName: string,
  startLine?: number | null,
  startColumn?: number | null
): string {
  const normPath = normalizeRelPath(filePath).replace(/[^a-zA-Z0-9_]/g, "_");
  const cleanName = symbolName.replace(/[^a-zA-Z0-9_]/g, "_");
  const linePart = startLine != null ? `_L${startLine}` : "";
  const colPart = startColumn != null ? `_C${startColumn}` : "";
  return `${normPath}_${cleanName}${linePart}${colPart}`;
}
