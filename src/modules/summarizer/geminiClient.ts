import { GoogleGenAI } from "@google/genai";
import { config } from "../../config/env.js";

export interface GeminiClientOptions {
  apiKey?: string;
  modelName?: string;
  minIntervalMs?: number; // Minimum ms between API calls for 15 RPM free tier (default 4000ms)
  mockMode?: boolean;
}

export class GeminiSummarizerClient {
  private ai: GoogleGenAI | null = null;
  private modelName: string;
  private candidateModels: string[];
  private minIntervalMs: number;
  private lastCallTime = 0;
  private throttlePromise: Promise<void> = Promise.resolve();
  private isMock: boolean;
  public callCount = 0;

  constructor(options: GeminiClientOptions = {}) {
    const apiKey = options.apiKey || config.gemini.apiKey;
    const baseModel = options.modelName || config.gemini.modelName;
    this.modelName = baseModel;
    this.candidateModels = [
      baseModel,
      "gemini-3.5-flash-lite",
      "gemini-3.5-flash"
    ].filter((m, idx, arr) => arr.indexOf(m) === idx);
    this.minIntervalMs = options.minIntervalMs ?? 4000;

    const isPlaceholder = !apiKey || apiKey.includes("your_gemini_api_key");

    if (options.mockMode || isPlaceholder) {
      this.isMock = true;
      if (!options.mockMode) {
        console.warn(
          "[GeminiClient] Notice: No valid GEMINI_API_KEY found in environment. Operating in intelligent Mock Mode."
        );
      }
    } else {
      this.isMock = false;
      this.ai = new GoogleGenAI({ apiKey });
    }
  }

  public get isMockMode(): boolean {
    return this.isMock;
  }

  private async throttle(): Promise<void> {
    if (this.isMock) return;

    this.throttlePromise = this.throttlePromise.then(async () => {
      const now = Date.now();
      const elapsed = now - this.lastCallTime;
      if (elapsed < this.minIntervalMs) {
        const waitTime = this.minIntervalMs - elapsed;
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
      this.lastCallTime = Date.now();
    });

    return this.throttlePromise;
  }

  public async generateJson<T = unknown>(prompt: string, fallbackMock: () => T): Promise<T> {
    this.callCount++;

    if (this.isMock || !this.ai) {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return fallbackMock();
    }

    const maxRetriesPerModel = 2;
    const totalAttempts = maxRetriesPerModel * this.candidateModels.length;
    let attempt = 0;
    let delay = 4000;
    let modelIndex = 0;

    while (attempt < totalAttempts) {
      const currentModel = this.candidateModels[modelIndex % this.candidateModels.length];
      try {
        await this.throttle();

        const response = await this.ai.models.generateContent({
          model: currentModel,
          contents: prompt,
          config: {
            responseMimeType: "application/json",
            temperature: 0.2
          }
        });

        const rawText = response.text || "";
        const cleanJson = rawText.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
        try {
          return JSON.parse(cleanJson) as T;
        } catch {
          const sanitized = cleanJson.replace(/\\(?!["\\/bfnrtu]|u[0-9a-fA-F]{4})/g, "\\\\");
          return JSON.parse(sanitized) as T;
        }
      } catch (err: unknown) {
        attempt++;
        modelIndex++;
        const nextModel = this.candidateModels[modelIndex % this.candidateModels.length];
        const errorMessage = err instanceof Error ? err.message : String(err);
        const isTransient =
          errorMessage.includes("429") ||
          errorMessage.includes("RESOURCE_EXHAUSTED") ||
          errorMessage.includes("quota") ||
          errorMessage.includes("503") ||
          errorMessage.includes("UNAVAILABLE") ||
          errorMessage.includes("high demand") ||
          errorMessage.includes("500") ||
          errorMessage.includes("fetch failed") ||
          errorMessage.includes("ECONNRESET");

        if (isTransient && attempt < totalAttempts) {
          const switchMsg = currentModel === nextModel 
            ? `cooling down for ${delay}ms`
            : `cooling down and switching to "${nextModel}" after ${delay}ms`;
          console.warn(
            `[GeminiClient] Rate-limit/transient notice on "${currentModel}" (${errorMessage.slice(0, 80)}). ${switchMsg}...`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay = Math.min(delay * 1.5, 12000);
        } else {
          console.warn(
            `[GeminiClient] Notice: Generation on "${currentModel}" encountered error (${errorMessage.slice(0, 90)}). Falling back to resilient AST summary generator.`
          );
          return fallbackMock();
        }
      }
    }

    console.warn(`[GeminiClient] Maximum attempts reached, using resilient fallback generator.`);
    return fallbackMock();
  }

  /**
   * Generates natural language or Markdown text without JSON schema constraints.
   */
  public async generateText(prompt: string, fallbackMock?: () => string): Promise<string> {
    this.callCount++;

    if (this.isMock || !this.ai) {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return fallbackMock ? fallbackMock() : "Mock response.";
    }

    const maxRetriesPerModel = 2;
    const totalAttempts = maxRetriesPerModel * this.candidateModels.length;
    let attempt = 0;
    let delay = 4000;
    let modelIndex = 0;

    while (attempt < totalAttempts) {
      const currentModel = this.candidateModels[modelIndex % this.candidateModels.length];
      try {
        await this.throttle();

        const response = await this.ai.models.generateContent({
          model: currentModel,
          contents: prompt,
          config: {
            temperature: 0.3
          }
        });

        const rawText = response.text || "";
        return rawText.trim();
      } catch (err: unknown) {
        attempt++;
        modelIndex++;
        const nextModel = this.candidateModels[modelIndex % this.candidateModels.length];
        const errorMessage = err instanceof Error ? err.message : String(err);
        const isTransient =
          errorMessage.includes("429") ||
          errorMessage.includes("RESOURCE_EXHAUSTED") ||
          errorMessage.includes("quota") ||
          errorMessage.includes("503") ||
          errorMessage.includes("UNAVAILABLE") ||
          errorMessage.includes("high demand") ||
          errorMessage.includes("500") ||
          errorMessage.includes("fetch failed") ||
          errorMessage.includes("ECONNRESET");

        if (isTransient && attempt < totalAttempts) {
          const switchMsg = currentModel === nextModel 
            ? `cooling down for ${delay}ms`
            : `cooling down and switching to "${nextModel}" after ${delay}ms`;
          console.warn(
            `[GeminiClient] Rate-limit/transient notice on "${currentModel}". ${switchMsg}...`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay = Math.min(delay * 1.5, 12000);
        } else {
          console.warn(
            `[GeminiClient] Notice: Text generation encountered notice (${errorMessage.slice(0, 90)}).`
          );
          if (fallbackMock) return fallbackMock();
          throw new Error(`Gemini API Error (${currentModel}): ${errorMessage}`);
        }
      }
    }

    if (fallbackMock) return fallbackMock();
    throw new Error(`Gemini API Error (${this.modelName}): Maximum retries exceeded.`);
  }

  /**
   * Generates a 768-dimensional embedding vector using gemini-embedding-001
   * or a deterministic normalized fallback vector if operating in mock mode.
   */
  public async generateEmbedding(text: string): Promise<number[]> {
    if (this.isMock || !this.ai) {
      return generateDeterministicMockVector(text, 768);
    }

    try {
      await this.throttle();
      const response = await this.ai.models.embedContent({
        model: "gemini-embedding-001",
        contents: text,
        config: {
          outputDimensionality: 768
        }
      });

      const values =
        response.embeddings?.[0]?.values ||
        (response as any).embedding?.values ||
        (response as any).values;
      if (values && values.length > 0) {
        return values;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[GeminiClient] Embedding notice (${msg.slice(0, 80)}), using fallback vector.`);
    }

    return generateDeterministicMockVector(text, 768);
  }
}

/**
 * Generates a normalized pseudo-random vector deterministically from text.
 */
export function generateDeterministicMockVector(text: string, dimensions = 768): number[] {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }

  const vector: number[] = new Array(dimensions);
  let seed = Math.abs(hash) || 1;

  for (let i = 0; i < dimensions; i++) {
    seed = (seed * 9301 + 49297) % 233280;
    vector[i] = (seed / 233280) * 2 - 1;
  }

  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => Number((v / norm).toFixed(6)));
}
