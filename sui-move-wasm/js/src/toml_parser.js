function stripInlineComment(line) {
  let inQuote = false;
  let quoteChar = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if ((ch === '"' || ch === "'") && (!inQuote || ch === quoteChar)) {
      inQuote = !inQuote;
      quoteChar = ch;
    }
    if (!inQuote && ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseScalar(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  const num = Number(trimmed);
  if (!Number.isNaN(num)) return num;
  return trimmed;
}

function parseInlineTable(value) {
  const result = {};
  const inner = value.trim().replace(/^\{/, "").replace(/\}$/, "");
  let current = "";
  let inQuote = false;
  let quoteChar = "";
  const parts = [];

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if ((ch === '"' || ch === "'") && (!inQuote || ch === quoteChar)) {
      inQuote = !inQuote;
      quoteChar = ch;
    }
    if (!inQuote && ch === ",") {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) {
    parts.push(current);
  }

  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    result[key] = parseScalar(val);
  }
  return result;
}

export function parseToml(content) {
  const result = {
    package: {},
    dependencies: {},
    addresses: {},
  };
  let section = null;
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = stripInlineComment(rawLine).trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1 || !section) continue;

    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();

    if (section === "package") {
      result.package[key.replace(/-/g, "_")] = parseScalar(value);
    } else if (section === "dependencies") {
      if (value.startsWith("{")) {
        result.dependencies[key] = parseInlineTable(value);
      } else {
        result.dependencies[key] = parseScalar(value);
      }
    } else if (section === "addresses") {
      result.addresses[key] = parseScalar(value);
    }
  }

  return result;
}
