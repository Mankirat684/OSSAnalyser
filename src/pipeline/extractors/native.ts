import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type {
  Extractor,
  ExtractionResult,
  ExtractedSymbol,
  ExtractedEdge,
  ExtractorContext
} from "../extractor.js";
import { NodeIdGenerator, makeCoordinateDisplayId, normalizeRelPath } from "../idGenerator.js";

export class NativeExtractor implements Extractor {
  public name: "native" = "native";

  public async version(): Promise<string> {
    return "1.0.0-native-ast";
  }

  public supports(languageOrExt: string): boolean {
    const ext = languageOrExt.startsWith(".") ? languageOrExt.toLowerCase() : `.${languageOrExt.toLowerCase()}`;
    return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"].includes(ext);
  }

  public async extract(files: string[], ctx: ExtractorContext): Promise<ExtractionResult> {
    const symbols: ExtractedSymbol[] = [];
    const edges: ExtractedEdge[] = [];
    const idGen = new NodeIdGenerator();

    for (const file of files) {
      const fullPath = path.isAbsolute(file) ? file : path.resolve(ctx.repoRoot, file);
      if (!fs.existsSync(fullPath)) continue;

      const relPath = normalizeRelPath(path.relative(ctx.repoRoot, fullPath));
      const content = fs.readFileSync(fullPath, "utf-8");
      const ext = path.extname(fullPath).toLowerCase();

      if (ext === ".py") {
        this.extractPython(relPath, content, symbols, edges, idGen);
      } else {
        this.extractTypeScript(relPath, content, symbols, edges, idGen);
      }
    }

    return { symbols, edges };
  }

  // =========================================================================
  // TypeScript & JavaScript Extraction
  // =========================================================================

  private extractTypeScript(
    relPath: string,
    content: string,
    symbols: ExtractedSymbol[],
    edges: ExtractedEdge[],
    idGen: NodeIdGenerator
  ): void {
    const lines = content.split(/\r?\n/);
    const fileSymbols: ExtractedSymbol[] = [];

    // Track explicit imports in the file: importedIdentifier -> sourceModule
    const importedIdentifiers = new Map<string, string>();
    for (const line of lines) {
      const trimmed = line.trim();
      const importMatch = trimmed.match(/^import\s+(?:\{([^}]+)\}|([a-zA-Z0-9_]+)|\*\s+as\s+([a-zA-Z0-9_]+))\s+from\s+['"]([^'"]+)['"]/);
      if (importMatch) {
        const namedGroup = importMatch[1];
        const defaultName = importMatch[2];
        const starName = importMatch[3];
        const sourceModule = importMatch[4];

        if (namedGroup) {
          const names = namedGroup.split(",").map((n) => n.trim().split(/\s+as\s+/)[0].trim());
          for (const n of names) {
            if (n) importedIdentifiers.set(n, sourceModule);
          }
        }
        if (defaultName) importedIdentifiers.set(defaultName, sourceModule);
        if (starName) importedIdentifiers.set(starName, sourceModule);
      }
    }

    let currentDocComment = "";
    let inDocComment = false;
    let currentClass: { name: string; symbolId: string } | null = null;
    let classBraceDepth = 0;
    let currentBraceDepth = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const lineNum = i + 1;

      // Track multi-line doc comments
      if (trimmed.startsWith("/**")) {
        inDocComment = true;
        currentDocComment = trimmed;
        if (trimmed.endsWith("*/")) inDocComment = false;
        continue;
      }
      if (inDocComment) {
        currentDocComment += `\n${trimmed}`;
        if (trimmed.endsWith("*/")) inDocComment = false;
        continue;
      }

      // Check class definition
      const classMatch = line.match(/(?:export\s+)?(?:abstract\s+)?class\s+([a-zA-Z0-9_]+)/);
      if (classMatch) {
        const className = classMatch[1];
        const startCol = (classMatch.index ?? 0) + 1;
        const qName = className;
        const symId = idGen.makeNodeId(relPath, qName, "class");
        const dispId = makeCoordinateDisplayId(relPath, className, lineNum, startCol);

        // Find class end line by matching braces
        const { endLine, endCol, sourceText } = this.findBlockSpan(lines, i, startCol - 1);
        const sourceHash = crypto.createHash("sha256").update(sourceText).digest("hex");

        const classSymbol: ExtractedSymbol = {
          id: symId,
          displayId: dispId,
          name: className,
          qualifiedName: qName,
          nodeType: "class",
          filePath: relPath,
          startLine: lineNum,
          endLine,
          startColumn: startCol,
          endColumn: endCol,
          signature: trimmed.split("{")[0].trim(),
          docComment: currentDocComment || undefined,
          exported: line.includes("export "),
          sourceHash,
          rawCode: sourceText
        };

        symbols.push(classSymbol);
        fileSymbols.push(classSymbol);
        currentClass = { name: className, symbolId: symId };
        classBraceDepth = currentBraceDepth;
        currentDocComment = "";
        continue;
      }

      // Check functions & methods
      const fnMatch =
        line.match(/(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)/) ||
        line.match(/(?:(?:public|private|protected|static|async)\s+)+([a-zA-Z0-9_]+)\s*\(([^)]*)\)/) ||
        line.match(/(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_]+)\s*(?::\s*[^=]+)?=\s*(?:async\s*)?\(?(?:<[^>]+>\s*)?\(?([^)]*)\)?\s*(?::\s*[^=]+)?=>/) ||
        line.match(/(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*(?::\s*[^=]+)?=>/) ||
        line.match(/^\s*([a-zA-Z0-9_]+)\s*\(([^)]*)\)\s*(?::\s*[^=]+)?\s*\{/);

      if (fnMatch && !trimmed.startsWith("if ") && !trimmed.startsWith("while ") && !trimmed.startsWith("switch ")) {
        const fnName = fnMatch[1];
        const isExcluded = ["constructor", "if", "for", "while", "switch", "catch"].includes(fnName);

        if (!isExcluded && fnName.length > 1) {
          const isMethod = currentClass !== null;
          const nodeType = isMethod ? "method" : "function";
          const qName = isMethod ? `${currentClass!.name}.${fnName}` : fnName;
          const startCol = (fnMatch.index ?? 0) + 1;
          const symId = idGen.makeNodeId(relPath, qName, nodeType);
          const dispId = makeCoordinateDisplayId(relPath, fnName, lineNum, startCol);

          const { endLine, endCol, sourceText } = this.findBlockSpan(lines, i, startCol - 1);
          const sourceHash = crypto.createHash("sha256").update(sourceText).digest("hex");

          const fnSymbol: ExtractedSymbol = {
            id: symId,
            displayId: dispId,
            name: fnName,
            qualifiedName: qName,
            nodeType,
            filePath: relPath,
            startLine: lineNum,
            endLine,
            startColumn: startCol,
            endColumn: endCol,
            signature: trimmed.split("{")[0].trim() || `${fnName}()`,
            docComment: currentDocComment || undefined,
            exported: line.includes("export "),
            sourceHash,
            rawCode: sourceText
          };

          symbols.push(fnSymbol);
          fileSymbols.push(fnSymbol);

          if (currentClass) {
            edges.push({
              sourceId: currentClass.symbolId,
              targetName: fnSymbol.id,
              relation: "contains",
              confidence: "EXTRACTED",
              line: lineNum
            });
          }

          currentDocComment = "";
        }
      }

      // Track brace nesting
      for (const char of line) {
        if (char === "{") currentBraceDepth++;
        else if (char === "}") {
          currentBraceDepth--;
          if (currentClass && currentBraceDepth <= classBraceDepth) {
            currentClass = null;
          }
        }
      }
    }

    // Call edge extraction within each symbol
    for (const sym of fileSymbols) {
      if (!sym.rawCode) continue;
      const fnLines = sym.rawCode.split("\n");

      for (let j = 0; j < fnLines.length; j++) {
        const fnLine = fnLines[j];
        const actualLine = sym.startLine + j;

        // Match invocations: e.g. fromB(), userService.describeUser()
        const callMatches = fnLine.matchAll(/(?:([a-zA-Z0-9_]+)\.)?([a-zA-Z0-9_]{2,})\s*\(/g);
        for (const match of callMatches) {
          const callee = match[2];
          if (
            ["if", "for", "while", "switch", "catch", "require", "import", "return", "describe", "it", "expect", "test"].includes(
              callee
            )
          ) {
            continue;
          }
          if (callee === sym.name) {
            // Recursive self-call
            edges.push({
              sourceId: sym.id,
              targetName: sym.name,
              relation: "calls",
              confidence: "EXTRACTED",
              line: actualLine
            });
          } else {
            edges.push({
              sourceId: sym.id,
              targetName: callee,
              relation: "calls",
              confidence: "EXTRACTED",
              line: actualLine
            });
          }
        }
      }
    }
  }

  // =========================================================================
  // Python Extraction
  // =========================================================================

  private extractPython(
    relPath: string,
    content: string,
    symbols: ExtractedSymbol[],
    edges: ExtractedEdge[],
    idGen: NodeIdGenerator
  ): void {
    const lines = content.split(/\r?\n/);
    const fileSymbols: ExtractedSymbol[] = [];

    let currentClass: { name: string; symbolId: string; indent: number } | null = null;
    let currentDocstring = "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const lineNum = i + 1;
      if (!trimmed || trimmed.startsWith("#")) continue;

      const indent = line.search(/\S/);
      if (currentClass && indent <= currentClass.indent) {
        currentClass = null;
      }

      // Check class
      const classMatch = line.match(/^(\s*)class\s+([a-zA-Z0-9_]+)(?:\(([^)]*)\))?:/);
      if (classMatch) {
        const className = classMatch[2];
        const startCol = indent + 1;
        const qName = className;
        const symId = idGen.makeNodeId(relPath, qName, "class");
        const dispId = makeCoordinateDisplayId(relPath, className, lineNum, startCol);

        const { endLine, sourceText } = this.findPythonBlockSpan(lines, i, indent);
        const sourceHash = crypto.createHash("sha256").update(sourceText).digest("hex");

        const classSymbol: ExtractedSymbol = {
          id: symId,
          displayId: dispId,
          name: className,
          qualifiedName: qName,
          nodeType: "class",
          filePath: relPath,
          startLine: lineNum,
          endLine,
          startColumn: startCol,
          signature: trimmed,
          exported: !className.startsWith("_"),
          sourceHash,
          rawCode: sourceText
        };

        symbols.push(classSymbol);
        fileSymbols.push(classSymbol);
        currentClass = { name: className, symbolId: symId, indent };
        continue;
      }

      // Check def
      const defMatch = line.match(/^(\s*)(?:async\s+)?def\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)/);
      if (defMatch) {
        const fnName = defMatch[2];
        const isMethod = currentClass !== null;
        const nodeType = isMethod ? "method" : "function";
        const qName = isMethod ? `${currentClass!.name}.${fnName}` : fnName;
        const startCol = indent + 1;
        const symId = idGen.makeNodeId(relPath, qName, nodeType);
        const dispId = makeCoordinateDisplayId(relPath, fnName, lineNum, startCol);

        const { endLine, sourceText } = this.findPythonBlockSpan(lines, i, indent);
        const sourceHash = crypto.createHash("sha256").update(sourceText).digest("hex");

        const fnSymbol: ExtractedSymbol = {
          id: symId,
          displayId: dispId,
          name: fnName,
          qualifiedName: qName,
          nodeType,
          filePath: relPath,
          startLine: lineNum,
          endLine,
          startColumn: startCol,
          signature: trimmed.split(":")[0] + ":",
          exported: !fnName.startsWith("_"),
          sourceHash,
          rawCode: sourceText
        };

        symbols.push(fnSymbol);
        fileSymbols.push(fnSymbol);

        if (currentClass) {
          edges.push({
            sourceId: currentClass.symbolId,
            targetName: fnSymbol.id,
            relation: "contains",
            confidence: "EXTRACTED",
            line: lineNum
          });
        }
      }
    }

    // Call references in Python
    for (const sym of fileSymbols) {
      if (!sym.rawCode) continue;
      const fnLines = sym.rawCode.split("\n");

      for (let j = 0; j < fnLines.length; j++) {
        const fnLine = fnLines[j];
        const actualLine = sym.startLine + j;

        const callMatches = fnLine.matchAll(/(?:([a-zA-Z0-9_]+)\.)?([a-zA-Z0-9_]{2,})\s*\(/g);
        for (const match of callMatches) {
          const callee = match[2];
          if (["if", "for", "while", "print", "len", "range", "dict", "list", "set", "str", "int"].includes(callee)) {
            continue;
          }
          edges.push({
            sourceId: sym.id,
            targetName: callee,
            relation: "calls",
            confidence: "EXTRACTED",
            line: actualLine
          });
        }
      }
    }
  }

  // =========================================================================
  // Block Span Finders
  // =========================================================================

  private findBlockSpan(
    lines: string[],
    startLineIdx: number,
    startColIdx: number
  ): { endLine: number; endCol: number; sourceText: string } {
    let braceDepth = 0;
    let foundStart = false;
    let endLine = startLineIdx + 1;
    let endCol = 1;

    const collectedLines: string[] = [];

    for (let i = startLineIdx; i < lines.length; i++) {
      const line = lines[i];
      collectedLines.push(line);

      for (let c = 0; c < line.length; c++) {
        if (line[c] === "{") {
          braceDepth++;
          foundStart = true;
        } else if (line[c] === "}") {
          braceDepth--;
          if (foundStart && braceDepth === 0) {
            endLine = i + 1;
            endCol = c + 1;
            return {
              endLine,
              endCol,
              sourceText: collectedLines.join("\n")
            };
          }
        }
      }
    }

    return {
      endLine: lines.length,
      endCol: (lines[lines.length - 1] || "").length + 1,
      sourceText: collectedLines.join("\n")
    };
  }

  private findPythonBlockSpan(
    lines: string[],
    startLineIdx: number,
    baseIndent: number
  ): { endLine: number; sourceText: string } {
    const collectedLines = [lines[startLineIdx]];
    let endLine = startLineIdx + 1;

    for (let i = startLineIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        collectedLines.push(line);
        endLine = i + 1;
        continue;
      }

      const indent = line.search(/\S/);
      if (indent <= baseIndent) {
        break;
      }

      collectedLines.push(line);
      endLine = i + 1;
    }

    return {
      endLine,
      sourceText: collectedLines.join("\n")
    };
  }
}
