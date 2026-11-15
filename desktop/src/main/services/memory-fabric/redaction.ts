export const MAX_SOURCE_CHARACTERS = 2 * 1024 * 1024;
export const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const REDACTED = "[REDACTED_CREDENTIAL]";
const wellFormed = (value: string) => value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");

function redact(text: string): string {
  return text
    .replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16})\b/g, REDACTED)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, `Bearer ${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|client[_-]?secret)["']?\s*[:=]\s*)(["'])([^\r\n]*?)\2/gi, `$1$2${REDACTED}$2`)
    .replace(/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret)\s*[:=]\s*)(?!\[REDACTED_)[^\s,;}"']+/gi, `$1${REDACTED}`)
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`);
}

/** Best-effort recognizable-secret filtering, not a claim to detect all private data. */
export function redactMemoryText(original: string): { text: string; redacted: boolean; omissions: string[]; originalCharacters: number } {
  const omissions: string[] = [];
  let text = original.slice(0, MAX_SOURCE_CHARACTERS);
  if (text.length < original.length) {
    if (/[\uD800-\uDBFF]/.test(text.at(-1) ?? "")) text = text.slice(0, -1);
    omissions.push(`Source exceeded ${MAX_SOURCE_CHARACTERS} UTF-16 characters; its remaining tail was not retained.`);
  }
  const unicodeText = wellFormed(text);
  if (unicodeText !== text) {
    text = unicodeText;
    omissions.push("Invalid isolated UTF-16 surrogates were replaced before UTF-8 storage.");
  }
  const filtered = redact(text);
  const redacted = filtered !== text;
  text = filtered;
  if (redacted) omissions.push("Recognizable credentials or private-key material were redacted before retention; this is not a complete secret detector.");
  if (text.length > MAX_SOURCE_CHARACTERS) {
    text = wellFormed(text.slice(0, MAX_SOURCE_CHARACTERS));
    omissions.push("Redacted source text was shortened to the retained-character limit.");
  }
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length > MAX_SOURCE_BYTES) {
    let end = MAX_SOURCE_BYTES;
    while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
    text = encoded.subarray(0, end).toString("utf8");
    omissions.push(`Source exceeded ${MAX_SOURCE_BYTES} UTF-8 bytes; its remaining tail was not retained.`);
  }
  return { text, redacted, omissions, originalCharacters: original.length };
}

export function redactMemoryMetadata(value: string | undefined, maximum: number): string | undefined {
  if (!value) return undefined;
  return wellFormed(redact(value.slice(0, maximum)).slice(0, maximum));
}
