import * as crypto from "node:crypto";
import { GoogleGenAI } from "@google/genai";

export interface EmbeddingProvider {
  name: string;
  model: string;
  dims: number;
  embed(texts: string[], kind: "document" | "query"): Promise<Float32Array[]>;
}

/**
 * Deterministic local semantic projection for offline testing and fallback.
 * Maps tokens into 768-dimensional normalized Float32 vectors via feature hashing.
 */
export class LocalHashEmbeddingProvider implements EmbeddingProvider {
  public name = "local-hash";
  public model = "hash-768";
  public dims = 768;

  public async embed(texts: string[], kind: "document" | "query"): Promise<Float32Array[]> {
    return texts.map((text) => {
      const vec = new Float32Array(this.dims);
      const tokens = text.toLowerCase().split(/[^a-zA-Z0-9_]+/).filter(Boolean);

      for (const token of tokens) {
        const hash = crypto.createHash("md5").update(token).digest();
        const index = hash.readUInt16LE(0) % this.dims;
        const sign = (hash[2] % 2 === 0) ? 1.0 : -1.0;
        vec[index] += sign;
      }

      // Normalize vector (L2 norm) for cosine distance
      let norm = 0;
      for (let i = 0; i < this.dims; i++) norm += vec[i] * vec[i];
      norm = Math.sqrt(norm);
      if (norm > 0) {
        for (let i = 0; i < this.dims; i++) vec[i] /= norm;
      }

      return vec;
    });
  }
}

/**
 * Local neural embedding provider running 100% on CPU via ONNX Runtime & Transformers.js.
 * Produces 768-dimensional normalized Float32 vectors using BAAI/bge-base-en-v1.5.
 * Requires zero external API keys and runs completely offline once weights are cached.
 * This is the DEFAULT embedding provider for OSS Analyser.
 */
export class LocalOnnxEmbeddingProvider implements EmbeddingProvider {
  public name = "local-onnx";
  public model = "Xenova/bge-base-en-v1.5";
  public dims = 768;

  private pipe: any = null;
  private initPromise: Promise<any> | null = null;
  private fallback = new LocalHashEmbeddingProvider();

  constructor(model?: string, dims = 768) {
    if (model) this.model = model;
    this.dims = dims;
  }

  public async getPipeline(): Promise<any> {
    if (this.pipe) return this.pipe;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        try {
          const { pipeline } = await import("@xenova/transformers");
          this.pipe = await pipeline("feature-extraction", this.model, { quantized: true });
          return this.pipe;
        } catch (err) {
          console.error(`[LocalOnnxEmbeddingProvider] Warning: Failed to load ONNX model ${this.model}. Falling back to LocalHash:`, err);
          return null;
        }
      })();
    }
    return this.initPromise;
  }

  public async embed(texts: string[], kind: "document" | "query"): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    try {
      const extractor = await this.getPipeline();
      if (!extractor) {
        return this.fallback.embed(texts, kind);
      }

      // For BGE retrieval: queries can be prefixed with query instruction
      const inputTexts = kind === "query"
        ? texts.map((t) => `Represent this sentence for searching relevant passages: ${t}`)
        : texts;

      // Process in batches of 16 to keep memory footprint bounded
      const BATCH_SIZE = 16;
      const allVectors: Float32Array[] = [];

      for (let i = 0; i < inputTexts.length; i += BATCH_SIZE) {
        const batch = inputTexts.slice(i, i + BATCH_SIZE);
        const out = await extractor(batch, { pooling: "mean", normalize: true });

        for (let j = 0; j < batch.length; j++) {
          const vec = new Float32Array(this.dims);
          vec.set(out.data.subarray(j * this.dims, (j + 1) * this.dims));
          allVectors.push(vec);
        }
      }

      return allVectors;
    } catch (err) {
      console.error(`[LocalOnnxEmbeddingProvider] Embedding error, falling back to hash:`, err);
      return this.fallback.embed(texts, kind);
    }
  }
}

/**
 * Cloud embedding provider using Google Gemini gemini-embedding-2 (768 dimensions).
 */
export class GeminiEmbeddingProvider implements EmbeddingProvider {
  public name = "gemini";
  public model = "gemini-embedding-2";
  public dims = 768;
  private apiKey: string;

  constructor(apiKey?: string) {
    const key = apiKey || process.env.GEMINI_API_KEY;
    if (!key) {
      throw new Error("GEMINI_API_KEY required for GeminiEmbeddingProvider");
    }
    this.apiKey = key;
  }

  public async embed(texts: string[], kind: "document" | "query"): Promise<Float32Array[]> {
    const results: Float32Array[] = [];
    const taskType = kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";

    for (const text of texts) {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:embedContent?key=${this.apiKey}`;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: { parts: [{ text }] },
          taskType,
          outputDimensionality: this.dims
        })
      });
      const data = (await res.json()) as any;
      if (!data.embedding || !data.embedding.values) {
        throw new Error(`Embedding API error: ${JSON.stringify(data.error || data)}`);
      }
      results.push(new Float32Array(data.embedding.values));
    }

    return results;
  }
}

/**
 * Factory function to retrieve the optimal embedding provider.
 * Defaults to LocalOnnxEmbeddingProvider (768 dims, 0 API keys required).
 * If GEMINI_API_KEY is explicitly supplied in the environment, uses GeminiEmbeddingProvider.
 */
export function getDefaultEmbeddingProvider(): EmbeddingProvider {
  if (process.env.GEMINI_API_KEY) {
    try {
      return new GeminiEmbeddingProvider(process.env.GEMINI_API_KEY);
    } catch {
      return new LocalOnnxEmbeddingProvider();
    }
  }
  // Default: 100% offline local neural 768-d ONNX model
  return new LocalOnnxEmbeddingProvider();
}
