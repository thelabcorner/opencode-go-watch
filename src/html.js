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

export function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (all, name) => ENTITY_MAP[name.toLowerCase()] ?? all);
}

export function textContent(fragment) {
  return decodeHtml(
    String(fragment ?? "")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/(?:p|div|li|h[1-6]|section|article|figcaption)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[\t\r ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeSpace(value) {
  return decodeHtml(String(value ?? "")).replace(/\s+/g, " ").trim();
}

export function extractHtmlTables(html) {
  const tables = [];
  for (const tableMatch of String(html ?? "").matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const rows = [];
    for (const rowMatch of tableMatch[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [];
      for (const cellMatch of rowMatch[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)) {
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
  const headingRe = new RegExp(`<h${nextHeadingLevel}\\b[^>]*>[\\s\\S]*?${headingPattern}[\\s\\S]*?<\\/h${nextHeadingLevel}>`, "i");
  const startMatch = headingRe.exec(source);
  if (!startMatch) return "";
  const start = startMatch.index;
  const rest = source.slice(start + startMatch[0].length);
  const next = new RegExp(`<h${nextHeadingLevel}\\b`, "i").exec(rest);
  return source.slice(start, next ? start + startMatch[0].length + next.index : source.length);
}
