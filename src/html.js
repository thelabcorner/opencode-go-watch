const ENTITY_MAP = Object.freeze({
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  le: "≤",
  ge: "≥",
});

const ENTITY_RE = /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi;
const SCRIPT_STYLE_RE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const TAG_RE = /<[^>]+>/g;
const BLOCK_BREAK_RE = /^<\s*(?:br\b|\/(?:p|div|li|h[1-6]|section|article|figcaption)\b)/i;
const TABLE_RE = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
const ROW_RE = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
const CELL_RE = /<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi;
const USAGE_LIMITS_ID_RE = /\bid\s*=\s*["']usage-limits["']/i;

export function decodeHtml(value) {
  const source = String(value ?? "");
  if (!source.includes("&")) return source;
  ENTITY_RE.lastIndex = 0;
  return source.replace(ENTITY_RE, (all, decimal, hex, name) => {
    if (decimal) return String.fromCodePoint(Number(decimal));
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    return ENTITY_MAP[String(name).toLowerCase()] ?? all;
  });
}

export function textContent(fragment) {
  let source = String(fragment ?? "");
  if (source.includes("<script") || source.includes("<style")) {
    SCRIPT_STYLE_RE.lastIndex = 0;
    source = source.replace(SCRIPT_STYLE_RE, " ");
  }
  TAG_RE.lastIndex = 0;
  source = source.replace(TAG_RE, (tag) => BLOCK_BREAK_RE.test(tag) ? "\n" : " ");
  return decodeHtml(source)
    .replace(/[\t\r ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeSpace(value) {
  const source = String(value ?? "");
  const decoded = source.includes("&") ? decodeHtml(source) : source;
  return decoded.replace(/\s+/g, " ").trim();
}

export function extractHtmlTables(html) {
  const source = String(html ?? "");
  const tables = [];
  TABLE_RE.lastIndex = 0;
  let tableMatch;
  while ((tableMatch = TABLE_RE.exec(source)) !== null) {
    const rows = [];
    ROW_RE.lastIndex = 0;
    let rowMatch;
    while ((rowMatch = ROW_RE.exec(tableMatch[1])) !== null) {
      const cells = [];
      CELL_RE.lastIndex = 0;
      let cellMatch;
      while ((cellMatch = CELL_RE.exec(rowMatch[1])) !== null) {
        cells.push(normalizeSpace(textContent(cellMatch[1])));
      }
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}

export function extractSectionHtml(html, headingPattern, nextHeadingLevel = 2) {
  const source = String(html ?? "");
  const headingTag = `<h${nextHeadingLevel}`;

  // Hot path for the exact section monitored by this Worker. Starlight renders a
  // stable id="usage-limits" anchor; finding it and slicing by tag boundaries is
  // materially cheaper than scanning the entire document with a lazy dot-all regex.
  if (/usage/i.test(headingPattern)) {
    const anchor = USAGE_LIMITS_ID_RE.exec(source);
    if (anchor) {
      const start = source.lastIndexOf(headingTag, anchor.index);
      if (start >= 0) {
        const next = source.indexOf(headingTag, anchor.index + anchor[0].length);
        return source.slice(start, next >= 0 ? next : source.length);
      }
    }
  }

  const headingRe = new RegExp(`<h${nextHeadingLevel}\\b[^>]*>[\\s\\S]*?${headingPattern}[\\s\\S]*?<\\/h${nextHeadingLevel}>`, "i");
  const startMatch = headingRe.exec(source);
  if (!startMatch) return "";
  const start = startMatch.index;
  const restStart = start + startMatch[0].length;
  const next = new RegExp(`<h${nextHeadingLevel}\\b`, "i").exec(source.slice(restStart));
  return source.slice(start, next ? restStart + next.index : source.length);
}
