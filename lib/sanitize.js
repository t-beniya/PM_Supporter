// @ts-check

const REDACTION_TEXT = "[redacted]";
const DEFAULT_MAX_TEXT_LENGTH = 300;
const SENSITIVE_KEY_PATTERN = "(?:api[-_\\s]?key|access[-_\\s]?token|refresh[-_\\s]?token|id[-_\\s]?token|token|password|passwd|pwd|secret|client[-_\\s]?secret|authorization)";
const SENSITIVE_ASSIGNMENT_PATTERN = new RegExp(`(["']?${SENSITIVE_KEY_PATTERN}["']?\\s*[:=]\\s*)(["']?)([^"'\\s,;&|<>]{4,})(\\2)`, "gi");
const AUTH_HEADER_PATTERN = /\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const URL_CREDENTIAL_PATTERN = /\b(https?:\/\/)([^:\s/@]+):([^@\s]+)@/gi;
const PRIVATE_KEY_BLOCK_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/**
 * @param {unknown} value
 */
function redactSensitiveText(value) {
  return String(value ?? "")
    .replace(PRIVATE_KEY_BLOCK_PATTERN, REDACTION_TEXT)
    .replace(URL_CREDENTIAL_PATTERN, "$1[redacted]@")
    .replace(AUTH_HEADER_PATTERN, `$1 ${REDACTION_TEXT}`)
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, (_match, prefix, quote, _secret, closingQuote) => `${prefix}${quote}${REDACTION_TEXT}${closingQuote}`);
}

/**
 * @param {unknown} value
 * @param {number} [maxLength]
 */
function sanitizeText(value, maxLength = DEFAULT_MAX_TEXT_LENGTH) {
  const normalized = redactSensitiveText(value).replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}...`;
}

/**
 * @param {unknown} values
 * @param {number} [maxItemLength]
 * @param {number} [maxItems]
 */
function sanitizeList(values, maxItemLength = DEFAULT_MAX_TEXT_LENGTH, maxItems = 20) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => sanitizeText(value, maxItemLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

module.exports = {
  REDACTION_TEXT,
  redactSensitiveText,
  sanitizeList,
  sanitizeText
};
