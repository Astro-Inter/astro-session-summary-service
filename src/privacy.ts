import { JobError } from "./config.ts";
const tokenPattern = /\[ASTRO_PII_[0-9a-f]{12}_[A-Z]+_\d+\]/g;
const patterns: Array<[string, RegExp]> = [
  ["EMAIL", /(?<![\p{L}\p{N}_.+-])[\p{L}\p{N}_.+-]+@[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+(?![\p{L}\p{N}_-])/gu],
  ["CNPJ", /(?<!\w)(?:\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{14})(?!\w)/g],
  ["CPF", /(?<!\w)(?:\d{3}\.\d{3}\.\d{3}-\d{2}|\d{11})(?!\w)/g],
  ["TELEFONE", /(?<!\w)(?:\+55\s*)?\(\d{2}\)\s*\d{4,5}[-\s]\d{4}(?!\d)/g],
  ["TELEFONE", /(?<!\w)(?:\+55\s*)?\d{2}\s+\d{4,5}-\d{4}(?!\d)/g],
  ["TELEFONE", /\b(?:telefone|celular|whatsapp)\s*:\s*(\+?[\d ()-]{8,22}\d)/gi],
  ["CEP", /\bCEP\s*:?\s*(\d{5}-?\d{3})(?!\d)/gi],
  ["CEP", /\b\d{5}-\d{3}\b/g],
  ["PESSOA", /\b(?:[Mm]eu nome [ée]|[Mm]e chamo)\s+([A-ZÀ-Ý][a-zà-ÿ]+(?:\s+[A-ZÀ-Ý][a-zà-ÿ]+){0,4})/g],
  ["PESSOA", /\b(?:nome|nome completo)\s*:\s*([^\n,;|.]{2,120})/gim],
];
export function redactSecrets(text: string): string {
  return text.replace(/("(?:senha|password|api_key|access_token|refresh_token|secret|authorization)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[SEGREDO_REMOVIDO]"')
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/-]+=*|(\b(?:senha|password|api[_-]?key|access[_-]?token|refresh[_-]?token|secret)\s*[:=]\s*)[^\s,;"}]+/gi, (_m, a, b) => (a || b) + "[SEGREDO_REMOVIDO]")
    .replace(/\b(?:gsk_[A-Za-z0-9]{12,}|sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, "[SEGREDO_REMOVIDO]");
}
export class PrivacyMap {
  private readonly scope = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  private readonly values = new Map<string, string>();
  private readonly identities = new Map<string, string>();
  mask(text: string): string {
    let result = redactSecrets(text);
    for (const [kind, pattern] of patterns) result = result.replace(pattern, (...args: any[]) => {
      const match = args[0] as string;
      const capture = typeof args[1] === "string" ? args[1] as string : undefined;
      if (/\[ASTRO_PII_/.test(match)) return match;
      const value = capture ?? match;
      const identity = kind + ":" + (["CPF", "CNPJ", "TELEFONE", "CEP"].includes(kind) ? value.replace(/\D/g, "") : value);
      let token = this.identities.get(identity);
      if (!token) { token = `[ASTRO_PII_${this.scope}_${kind}_${this.values.size + 1}]`; this.identities.set(identity, token); this.values.set(token, value); }
      return capture ? match.replace(capture, token) : token;
    });
    return result;
  }
  restore(text: string): string {
    return text.replace(tokenPattern, token => {
      const value = this.values.get(token);
      if (value === undefined) throw new JobError("invalid_privacy_token");
      return value;
    });
  }
}
export function redactForEmbedding(text: string): string {
  return new PrivacyMap().mask(text).replace(tokenPattern, token => "[" + token.split("_").at(-2) + "]");
}
