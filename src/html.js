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


const MONITOR_TOKEN_RE = /<\/?[A-Za-z][^>]*>|[^<]+/g;
const MONITOR_ATTR_RE = /([:@A-Za-z_][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const MONITOR_COMMENT_RE = /<!--[\s\S]*?-->/g;
const MONITOR_SVG_RE = /<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi;
const MONITOR_NOISE_BLOCK_RE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const MONITOR_NOISE_ATTRS = new Set([
  "class",
  "style",
  "id",
  "role",
  "tabindex",
  "aria-hidden",
  "data-slot",
  "data-visible",
  "data-component",
  "data-hk",
  "data-hydrate",
  "data-hydration",
]);

function canonicalAttributeValue(value) {
  return normalizeSpace(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Canonicalize a monitored HTML region for the unknown-change safety net.
 *
 * It deliberately removes presentation/hydration noise (class/style/Solid markers,
 * comments, scripts, and optionally SVG geometry), but preserves text, element
 * structure, links, and unfamiliar attributes such as a future
 * data-context-window. This is NOT used on the 304/fingerprint hot path; it only
 * runs when a monitored response body is already being inspected.
 */
export function canonicalMonitoredHtml(fragment, { dropSvg = false, includeText = true } = {}) {
  let source = String(fragment ?? "");
  MONITOR_COMMENT_RE.lastIndex = 0;
  source = source.replace(MONITOR_COMMENT_RE, " ");
  MONITOR_NOISE_BLOCK_RE.lastIndex = 0;
  source = source.replace(MONITOR_NOISE_BLOCK_RE, " ");
  if (dropSvg) {
    MONITOR_SVG_RE.lastIndex = 0;
    source = source.replace(MONITOR_SVG_RE, " ");
  }

  const out = [];
  MONITOR_TOKEN_RE.lastIndex = 0;
  let token;
  while ((token = MONITOR_TOKEN_RE.exec(source)) !== null) {
    const raw = token[0];
    if (!raw.startsWith("<")) {
      if (!includeText) continue;
      const text = normalizeSpace(raw);
      if (text) out.push(text);
      continue;
    }

    const closing = /^<\s*\//.test(raw);
    const nameMatch = /^<\s*\/?\s*([A-Za-z][\w:-]*)/.exec(raw);
    if (!nameMatch) continue;
    const name = nameMatch[1].toLowerCase();
    if (closing) {
      out.push(`</${name}>`);
      continue;
    }

    const attrs = [];
    const attrSource = raw.slice(nameMatch[0].length, raw.length - 1);
    MONITOR_ATTR_RE.lastIndex = 0;
    let attr;
    while ((attr = MONITOR_ATTR_RE.exec(attrSource)) !== null) {
      const attrName = attr[1].toLowerCase();
      if (MONITOR_NOISE_ATTRS.has(attrName) || attrName.startsWith("on")) continue;
      const rawValue = attr[2] ?? attr[3] ?? attr[4];
      attrs.push(rawValue == null
        ? attrName
        : `${attrName}="${canonicalAttributeValue(rawValue)}"`);
    }
    attrs.sort();
    out.push(`<${name}${attrs.length ? ` ${attrs.join(" ")}` : ""}>`);
  }

  return out.join(" ").replace(/\s+/g, " ").trim();
}

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
