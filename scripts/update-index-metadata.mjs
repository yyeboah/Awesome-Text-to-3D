#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const readmePath = path.join(root, "README.md");
const bibPath = path.join(root, "references", "citations.bib");
const reportPath = path.join(root, "references", "internal-citations.json");
const reportMarkdownPath = path.join(root, "references", "internal-citations.md");
const cachePath = "/private/tmp/awesome-text-to-3d-semantic-scholar-cache.json";
const apiBase = "https://api.semanticscholar.org/graph/v1";
const targetSections = new Set([
  "X-to-3D",
  "3D Editing, Decomposition & Stylization",
  "Avatar Generation and Manupilation",
  "Dynamic Content Generation",
  "World Models",
  "Datasets :floppy_disk:",
  "Frameworks & Projects :desktop_computer:",
]);

function normalizeTitle(value) {
  return value
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase();
}

function titleSimilarity(a, b) {
  const left = new Set(normalizeTitle(a).split(" ").filter(Boolean));
  const right = new Set(normalizeTitle(b).split(" ").filter(Boolean));
  const intersection = [...left].filter((token) => right.has(token)).length;
  const union = new Set([...left, ...right]).size;
  return union ? intersection / union : 0;
}

function parseYear(line) {
  const years = [...line.matchAll(/\b((?:19|20)\d{2})\b/g)].map((match) => Number(match[1]));
  return years.length ? years.at(-1) : null;
}

function arxivFallbackDate(arxivId) {
  if (!arxivId) return null;
  const match = arxivId.match(/^(\d{2})(\d{2})\./);
  if (!match) return null;
  const year = Number(match[1]) + 2000;
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? `${year}-${String(month).padStart(2, "0")}-01` : null;
}

function extractSection(line) {
  const details = line.match(/^<summary>(.+)<\/summary>$/);
  if (details) return details[1].trim();
  const heading = line.match(/^## (.+?)\s*$/);
  return heading ? heading[1].trim() : null;
}

function parseRows(readme, bib) {
  const lines = readme.split("\n");
  const bibLines = bib.split("\n");
  let section = "";
  const rows = [];

  for (let index = 0; index < lines.length; index += 1) {
    const nextSection = extractSection(lines[index]);
    if (nextSection) section = nextSection;
    if (!/^\s*- \[[^x ]/.test(lines[index]) || !targetSections.has(section)) continue;

    const rawLine = lines[index]
      .trim()
      .replace(
        / \| (?:(?:<a\b[^>]*>)?▲(?:<\/a>)? )?(?:internal citations|citation count): (?:\d+|unavailable)$/,
        "",
      );
    const title = rawLine.match(/^- \[([^\]]+)\]\(/)?.[1];
    if (!title) continue;
    const citationRange = rawLine.match(/citations\.bib#L(\d+)-L(\d+)/);
    const citationStart = Number(citationRange?.[1] || 0);
    const citationEnd = Number(citationRange?.[2] || 0);
    const bibEntry = citationStart && citationEnd - citationStart <= 20
      ? bibLines.slice(citationStart - 1, citationEnd).join("\n")
      : "";
    const arxiv =
      rawLine.match(/arxiv\.org\/(?:abs|pdf)\/([0-9]{4}\.[0-9]{4,5})/i)?.[1] ||
      bibEntry.match(/arxiv\.org\/(?:abs|pdf)\/([0-9]{4}\.[0-9]{4,5})/i)?.[1] ||
      bibEntry.match(/arXiv(?::| preprint arXiv:|\s*=\s*[{])\s*([0-9]{4}\.[0-9]{4,5})/i)?.[1] ||
      null;
    const doi = bibEntry.match(/\bdoi\s*=\s*[{\"]([^}\"]+)/i)?.[1] || null;
    const identifier = arxiv ? `ARXIV:${arxiv}` : doi ? `DOI:${doi}` : null;

    rows.push({
      lineIndex: index,
      section,
      rawLine,
      title,
      identifier,
      arxiv,
      fallbackDate: arxivFallbackDate(arxiv) || (parseYear(rawLine) ? `${parseYear(rawLine)}-01-01` : null),
      originalOrder: rows.length,
      hasCitation: citationStart > 0,
    });
  }
  return { lines, rows };
}

async function apiRequest(url, options = {}, attempts = 9) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetch(url, options);
    if (response.ok) return response.json();
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === attempts - 1) {
      throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
    }
    const retryAfter = Number(response.headers.get("retry-after") || 0);
    const delay = Math.min(60_000, Math.max(retryAfter * 1000, 2000 * 2 ** attempt));
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

async function saveCache(cache) {
  await fs.writeFile(cachePath, JSON.stringify(Object.fromEntries(cache)));
}

async function resolveBatch(identifiers, cache) {
  const results = new Map();
  const fields = "title,publicationDate,externalIds,references.paperId";
  const missing = identifiers.filter((id) => !cache.has(`id:${id}`));
  for (const id of identifiers) {
    if (cache.has(`id:${id}`)) results.set(id, cache.get(`id:${id}`));
  }
  for (let start = 0; start < missing.length; start += 25) {
    const ids = missing.slice(start, start + 25);
    const data = await apiRequest(`${apiBase}/paper/batch?fields=${encodeURIComponent(fields)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    ids.forEach((id, offset) => {
      const paper = data[offset] || null;
      results.set(id, paper);
      cache.set(`id:${id}`, paper);
    });
    await saveCache(cache);
    process.stderr.write(`Resolved identifiers ${Math.min(start + ids.length, missing.length)}/${missing.length}\n`);
  }
  return results;
}

async function resolveByTitle(rows, cache) {
  const results = new Map();
  const fields = "title,publicationDate,externalIds,references.paperId";
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const cacheKey = `title:${normalizeTitle(row.title)}`;
    if (cache.has(cacheKey)) {
      results.set(row.title, cache.get(cacheKey));
      continue;
    }
    try {
      const data = await apiRequest(
        `${apiBase}/paper/search/match?query=${encodeURIComponent(row.title)}&fields=${encodeURIComponent(fields)}`,
      );
      const candidate = data.data?.[0] || data;
      const paper = candidate && titleSimilarity(row.title, candidate.title || "") >= 0.82 ? candidate : null;
      results.set(row.title, paper);
      cache.set(cacheKey, paper);
    } catch (error) {
      if (!String(error).startsWith("Error: 404")) throw error;
      results.set(row.title, null);
      cache.set(cacheKey, null);
    }
    await saveCache(cache);
    process.stderr.write(`Resolved titles ${index + 1}/${rows.length}\n`);
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  return results;
}

function escapeHtmlAttribute(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function paperAnchor(row) {
  return row.paper?.paperId
    ? `s2-${row.paper.paperId}`
    : `title-${normalizeTitle(row.title).replaceAll(" ", "-")}`;
}

function addInternalCitationLabel(line, row) {
  const count = row.internalCitations;
  if (count === null) return `${line} | ▲ citation count: unavailable`;
  const citedBy = row.citedBy;
  const previewLimit = 8;
  const preview = citedBy.slice(0, previewLimit).join("; ");
  const remainder = citedBy.length - previewLimit;
  const tooltip = count === 0
    ? "No indexed papers cite this paper yet."
    : `Cited by: ${preview}${remainder > 0 ? `; and ${remainder} more. Click for the full list.` : ""}`;
  return `${line} | <a href="./references/internal-citations.md#${paperAnchor(row)}" title="${escapeHtmlAttribute(tooltip)}">▲</a> citation count: ${count}`;
}

function sortAndAnnotate(lines, rows) {
  const bySection = Map.groupBy(rows, (row) => row.section);
  for (const sectionRows of bySection.values()) {
    const sorted = [...sectionRows].sort((a, b) => {
      const byDate = (b.date || "0000-00-00").localeCompare(a.date || "0000-00-00");
      return byDate || a.originalOrder - b.originalOrder;
    });
    const targetIndices = sectionRows.map((row) => row.lineIndex).sort((a, b) => a - b);
    targetIndices.forEach((lineIndex, offset) => {
      const row = sorted[offset];
      lines[lineIndex] = row.hasCitation ? addInternalCitationLabel(row.rawLine, row) : row.rawLine;
    });
  }
  return lines;
}

async function main() {
  const [readme, bib] = await Promise.all([
    fs.readFile(readmePath, "utf8"),
    fs.readFile(bibPath, "utf8"),
  ]);
  const { lines, rows } = parseRows(readme, bib);
  const citationRows = rows.filter((row) => row.hasCitation);
  let priorReport = { entries: [] };
  try {
    priorReport = JSON.parse(await fs.readFile(reportPath, "utf8"));
  } catch {}
  const priorIds = new Map(
    (priorReport.entries || [])
      .filter((entry) => entry.semanticScholarPaperId)
      .map((entry) => [normalizeTitle(entry.title), entry.semanticScholarPaperId]),
  );
  let cache = new Map();
  try {
    cache = new Map(Object.entries(JSON.parse(await fs.readFile(cachePath, "utf8"))));
  } catch {}
  for (const row of citationRows) {
    row.lookupIdentifier = row.identifier || priorIds.get(normalizeTitle(row.title)) || null;
  }
  const identifiers = [...new Set(citationRows.map((row) => row.lookupIdentifier).filter(Boolean))];
  const byIdentifier = await resolveBatch(identifiers, cache);

  for (const row of citationRows) {
    const candidate = row.lookupIdentifier ? byIdentifier.get(row.lookupIdentifier) : null;
    row.paper = candidate && titleSimilarity(row.title, candidate.title || "") >= 0.65 ? candidate : null;
  }
  const titleRows = citationRows.filter((row) => !row.paper);
  const byTitle = await resolveByTitle(
    [...new Map(titleRows.map((row) => [normalizeTitle(row.title), row])).values()],
    cache,
  );
  for (const row of titleRows) row.paper = byTitle.get(row.title) || null;

  const papersById = new Map();
  for (const row of citationRows) {
    if (row.paper?.paperId && !papersById.has(row.paper.paperId)) papersById.set(row.paper.paperId, row.paper);
  }
  const citingTitlesByTarget = new Map([...papersById.keys()].map((id) => [id, new Set()]));
  for (const paper of papersById.values()) {
    for (const reference of paper.references || []) {
      if (reference?.paperId && citingTitlesByTarget.has(reference.paperId) && reference.paperId !== paper.paperId) {
        citingTitlesByTarget.get(reference.paperId).add(paper.title);
      }
    }
  }

  for (const row of rows) {
    row.date = row.paper?.publicationDate || row.fallbackDate;
    row.internalCitations = row.paper?.paperId ? citingTitlesByTarget.get(row.paper.paperId)?.size ?? 0 : null;
    row.citedBy = row.paper?.paperId ? [...(citingTitlesByTarget.get(row.paper.paperId) || [])].sort() : [];
  }

  const generatedAt = new Date().toISOString();
  const resolvedRows = citationRows.filter((row) => row.paper?.paperId).length;
  const methodology = `- Citation count measures distinct papers elsewhere in this index that [Semantic Scholar](https://api.semanticscholar.org/api-docs/graphs) reports as citing an entry (refreshed ${generatedAt.slice(0, 10)}; ${papersById.size} distinct works, ${resolvedRows}/${citationRows.length} citation-backed rows resolved).`;
  const oldMethodology = lines.findIndex((line) =>
    line.startsWith("- Internal citations count distinct papers elsewhere in this index") ||
    line.startsWith("- Citation count measures distinct papers elsewhere in this index"),
  );
  if (oldMethodology >= 0) lines[oldMethodology] = methodology;
  else {
    const insertionPoint = lines.findIndex((line) => line.startsWith("- updated incrementally"));
    lines.splice(insertionPoint + 1, 0, methodology);
    for (const row of rows) row.lineIndex += 1;
  }

  const outputLines = sortAndAnnotate(lines, rows);
  await fs.writeFile(readmePath, `${outputLines.join("\n").replace(/\n+$/, "")}\n`);

  const reportEntries = citationRows.map((row) => ({
    title: row.title,
    section: row.section,
    identifier: row.identifier,
    semanticScholarPaperId: row.paper?.paperId || null,
    semanticScholarTitle: row.paper?.title || null,
    publicationDate: row.date,
    internalCitationCount: row.internalCitations,
    citedBy: row.citedBy,
  }));
  await fs.writeFile(
    reportPath,
    `${JSON.stringify({
      source: "Semantic Scholar Academic Graph API",
      sourceUrl: "https://api.semanticscholar.org/api-docs/graphs",
      generatedAt,
      definition: "Distinct resolved papers in this README whose Semantic Scholar reference lists include the target paper.",
      resolvedRows,
      citationBackedRows: citationRows.length,
      distinctResolvedWorks: papersById.size,
      entries: reportEntries,
    }, null, 2)}\n`,
  );

  const representativeRows = [...new Map(
    citationRows
      .filter((row) => row.paper?.paperId)
      .map((row) => [row.paper.paperId, row]),
  ).values()].sort((a, b) =>
    b.internalCitations - a.internalCitations ||
    (b.date || "0000-00-00").localeCompare(a.date || "0000-00-00") ||
    a.title.localeCompare(b.title),
  );
  const markdown = [
    "# Citation counts",
    "",
    `Generated ${generatedAt.slice(0, 10)} from the Semantic Scholar reference graph. Counts include only distinct papers indexed in this repository.`,
    "",
  ];
  for (const row of representativeRows) {
    markdown.push(`<a id="${paperAnchor(row)}"></a>`);
    markdown.push(`## ${row.title}`);
    markdown.push("");
    markdown.push(`**Citation count:** ${row.internalCitations}`);
    markdown.push("");
    if (row.citedBy.length) {
      markdown.push(...row.citedBy.map((title) => `- ${title}`));
    } else {
      markdown.push("No other indexed papers cite this paper.");
    }
    markdown.push("");
  }
  await fs.writeFile(reportMarkdownPath, `${markdown.join("\n").replace(/\n+$/, "")}\n`);

  process.stderr.write(`Updated ${rows.length} dated index rows; resolved ${resolvedRows}/${citationRows.length} citation-backed rows.\n`);
}

await main();
