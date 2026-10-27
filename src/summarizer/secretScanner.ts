/**
 * Regex-based secret scanner complying with Section 9 of the spec.
 * Redacts AWS keys, private keys, API keys, tokens, and JWTs prior to sending to LLMs.
 */

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  // AWS Access Key ID
  { name: "AWS Key", pattern: /(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/g },
  // Generic API Keys / Tokens in assignments (e.g., api_key = "...", token: '...')
  { name: "API Key Assignment", pattern: /(?:api[_-]?key|secret|token|password|auth[_-]?token)\s*[:=]\s*["']([^"'\s]{8,})["']/gi },
  // Private Key Headers
  { name: "Private Key", pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]+?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g },
  // JSON Web Tokens (JWT)
  { name: "JWT", pattern: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g },
  // Bearer tokens
  { name: "Bearer Token", pattern: /Bearer\s+[a-zA-Z0-9_\-\.=:_+/]{20,}/gi }
];

export interface RedactionResult {
  text: string;
  redactedCount: number;
}

export class SecretScanner {
  public static scanAndRedact(text: string): RedactionResult {
    let redactedText = text;
    let totalRedacted = 0;

    for (const { pattern, name } of SECRET_PATTERNS) {
      // Reset lastIndex for global regexes
      pattern.lastIndex = 0;

      if (name === "API Key Assignment") {
        redactedText = redactedText.replace(pattern, (match, capture) => {
          totalRedacted++;
          if (capture) {
            return match.replace(capture, "[REDACTED]");
          }
          return match;
        });
      } else {
        redactedText = redactedText.replace(pattern, () => {
          totalRedacted++;
          return "[REDACTED]";
        });
      }
    }

    return {
      text: redactedText,
      redactedCount: totalRedacted
    };
  }
}
