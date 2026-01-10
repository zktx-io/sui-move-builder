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

function parseInlineArray(value: string): any[] {
  const result: any[] = [];
  const inner = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  let current = "";
  let inQuote = false;
  let quoteChar = "";
  let depth = 0; // Track nested braces

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];

    if ((ch === '"' || ch === "'") && (!inQuote || ch === quoteChar)) {
      inQuote = !inQuote;
      quoteChar = inQuote ? ch : "";
    }

    if (!inQuote) {
      if (ch === "{") depth++;
      if (ch === "}") depth--;
      if (ch === "," && depth === 0) {
        if (current.trim()) {
          result.push(parseInlineValue(current.trim()));
        }
        current = "";
        continue;
      }
    }
    current += ch;
  }

  if (current.trim()) {
    result.push(parseInlineValue(current.trim()));
  }

  return result;
}

function parseInlineValue(value: string): any {
  if (value.startsWith("{")) {
    return parseInlineTable(value);
  }
  return parseScalar(value);
}

export function parseToml(content: string): any {
  const result: any = {};
  let section: string | null = null;
  let isArraySection = false;
  const rawLines = content.split(/\r?\n/);

  // Merge multi-line arrays
  const lines: string[] = [];
  let i = 0;
  while (i < rawLines.length) {
    const line = stripInlineComment(rawLines[i]);
    // Check if this line starts a multi-line array
    if (
      line.match(/=\s*\[\s*$/) ||
      (line.includes("=") && line.includes("[") && !line.includes("]"))
    ) {
      let merged = line;
      i++;
      // Keep merging until we find the closing ]
      while (i < rawLines.length && !merged.includes("]")) {
        merged += " " + stripInlineComment(rawLines[i]).trim();
        i++;
      }
      // If we stopped before finding ], add the current line (which should have ])
      if (
        i < rawLines.length &&
        merged.includes("[") &&
        !merged.includes("]")
      ) {
        merged += " " + stripInlineComment(rawLines[i]).trim();
        i++;
      }
      lines.push(merged);
    } else {
      lines.push(line);
      i++;
    }
  }

  // Helper to get nested value using dot notation path
  function getNestedValue(obj: any, path: string[]): any {
    let current = obj;
    for (const key of path) {
      if (!(key in current)) {
        return undefined;
      }
      current = current[key];
    }
    return current;
  }

  for (const rawLine of lines) {
    const line = stripInlineComment(rawLine).trim();
    if (!line) continue;

    // Check for array sections like [[move.package]]
    const arraySectionMatch = line.match(/^\[\[([^\]]+)\]\]$/);
    if (arraySectionMatch) {
      section = arraySectionMatch[1].trim();
      isArraySection = true;

      // Parse section path (e.g., "move.package" -> ["move", "package"])
      const path = section.split(".");

      // Navigate/create nested structure
      let current = result;
      for (let i = 0; i < path.length - 1; i++) {
        const key = path[i];
        if (!(key in current)) {
          current[key] = {};
        }
        current = current[key];
      }

      // Last key should be an array
      const arrayKey = path[path.length - 1];
      if (!Array.isArray(current[arrayKey])) {
        current[arrayKey] = [];
      }
      // Push new object to array
      current[arrayKey].push({});
      continue;
    }

    // Check for regular sections like [move] or [move.toolchain-version]
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      isArraySection = false;
      continue;
    }

    const eq = line.indexOf("=");
    if (eq === -1 || !section) continue;

    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();

    // Parse value
    let parsedValue: any;
    if (value.startsWith("{")) {
      parsedValue = parseInlineTable(value);
    } else if (value.startsWith("[")) {
      // Inline array like [{ name = "Sui" }]
      parsedValue = parseInlineArray(value);
    } else {
      parsedValue = parseScalar(value);
    }

    if (isArraySection) {
      // Add to last item in array
      const path = section.split(".");
      const nested = getNestedValue(result, path);
      if (Array.isArray(nested) && nested.length > 0) {
        const lastItem = nested[nested.length - 1];
        lastItem[key] = parsedValue;
      }
    } else {
      // Add to nested object
      const path = section.split(".");
      // Navigate/create nested structure
      let current = result;
      for (const part of path) {
        if (!(part in current)) {
          current[part] = {};
        }
        current = current[part];
      }
      // Special handling for key normalization in "package" section
      const finalKey = section === "package" ? key.replace(/-/g, "_") : key;
      current[finalKey] = parsedValue;
    }
  }

  return result;
}
