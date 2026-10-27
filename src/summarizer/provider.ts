/**
 * Pluggable LLM Provider interface conforming to Section 5.2 of the spec.
 */

export interface CompletionRequest {
  system?: string;
  prompt: string;
  maxTokens: number;
  json?: boolean;
}

export interface CompletionResponse {
  text: string;
  tokensIn: number;
  tokensOut: number;
}

export interface LlmProvider {
  name: string;
  models: string[];
  countTokens?(text: string): Promise<number>;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}
