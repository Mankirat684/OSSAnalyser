import type { LlmProvider, CompletionRequest, CompletionResponse } from "../provider.js";
import { estimateTokens } from "../../mcp/envelope.js";

export class HeuristicProvider implements LlmProvider {
  public name = "heuristic";
  public models = ["ast-heuristics-v1"];

  public async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const text = "Heuristic summary: Extracted code component with interface signature.";
    return {
      text,
      tokensIn: estimateTokens(req.prompt),
      tokensOut: estimateTokens(text)
    };
  }

  public static generateFunctionSummary(name: string, signature: string, docComment?: string, callees: string[] = []): string {
    const parts: string[] = [];
    if (docComment) {
      parts.push(docComment.replace(/[\/\*]/g, "").trim().split("\n")[0]);
    } else {
      parts.push(`Executes ${name} operation.`);
    }

    if (callees.length > 0) {
      parts.push(`Delegates to: ${callees.slice(0, 4).join(", ")}.`);
    }

    return parts.join(" ");
  }

  public static generateFileContract(filePath: string, exportedSymbols: string[]): string {
    if (exportedSymbols.length === 0) {
      return `Module providing utility implementations for ${filePath}.`;
    }
    return `Provides ${exportedSymbols.slice(0, 5).join(", ")} operations within ${filePath}.`;
  }
}
