import type { LlmProvider, CompletionRequest, CompletionResponse } from "../provider.js";
import { SecretScanner } from "../secretScanner.js";
import { estimateTokens } from "../../mcp/envelope.js";

export class OllamaProvider implements LlmProvider {
  public name = "ollama";
  public models = ["llama3.2", "codellama", "mistral", "qwen2.5-coder"];
  private host: string;
  private model: string;

  constructor(model = "qwen2.5-coder", host = "http://localhost:11434") {
    this.model = model;
    this.host = host.replace(/\/$/, "");
  }

  public async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const redactedPrompt = SecretScanner.scanAndRedact(req.prompt).text;
    const tokensIn = estimateTokens(redactedPrompt);

    const body: Record<string, unknown> = {
      model: this.model,
      prompt: req.system ? `${req.system}\n\n${redactedPrompt}` : redactedPrompt,
      stream: false,
      options: {
        temperature: 0.2,
        num_predict: req.maxTokens || 250
      }
    };
    if (req.json) {
      body.format = "json";
    }

    const response = await fetch(`${this.host}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed with HTTP ${response.status}: ${await response.text()}`);
    }

    const json = (await response.json()) as any;
    const text = json.response || "";
    return {
      text,
      tokensIn,
      tokensOut: estimateTokens(text)
    };
  }
}
