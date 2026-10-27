import type { LlmProvider, CompletionRequest, CompletionResponse } from "../provider.js";
import { GeminiSummarizerClient } from "../../modules/summarizer/geminiClient.js";
import { SecretScanner } from "../secretScanner.js";
import { estimateTokens } from "../../mcp/envelope.js";

export class GeminiProvider implements LlmProvider {
  public name = "gemini";
  public models = ["gemini-3.5-flash-lite", "gemini-3.5-flash"];
  private client: GeminiSummarizerClient;

  constructor(apiKey?: string, modelName?: string, mockMode = false) {
    this.client = new GeminiSummarizerClient({
      apiKey: apiKey || process.env.GEMINI_API_KEY,
      modelName: modelName || "gemini-3.5-flash-lite",
      mockMode
    });
  }

  public async complete(req: CompletionRequest): Promise<CompletionResponse> {
    // 1. Scan and redact secrets before sending out of machine
    const redactedPrompt = SecretScanner.scanAndRedact(req.prompt).text;
    const tokensIn = estimateTokens(redactedPrompt);

    // 2. Generate completion
    if (req.json) {
      const jsonRes = await this.client.generateJson(redactedPrompt, () => {
        return { summary: "Heuristic: Operations within file." };
      });
      const text = typeof jsonRes === "string" ? jsonRes : JSON.stringify(jsonRes);
      return {
        text,
        tokensIn,
        tokensOut: estimateTokens(text)
      };
    }

    const text = await this.client.generateText(redactedPrompt, () => "Analyzes code component.");
    return {
      text,
      tokensIn,
      tokensOut: estimateTokens(text)
    };
  }
}
