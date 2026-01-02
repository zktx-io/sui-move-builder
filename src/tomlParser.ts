function stripInlineComment(line: string): string {
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

function parseScalar(value: string): any {
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

function parseInlineTable(value: string): Record<string, any> {
  const result: Record<string, any> = {};
  const inner = value.trim().replace(/^\{/, "").replace(/\}$/, "");
  let current = "";
  let inQuote = false;
  let quoteChar = "";
  const parts: string[] = [];

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

export function parseToml(content: string): {
  package: Record<string, any>;
  dependencies: Record<string, any>;
  addresses: Record<string, any>;
} {
  const result = {
    package: {},
    dependencies: {},
    addresses: {},
  } as {
    package: Record<string, any>;
    dependencies: Record<string, any>;
    addresses: Record<string, any>;
  };
  let section: string | null = null;
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
