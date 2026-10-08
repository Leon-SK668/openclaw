import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";

type FtsCanonicalTokenizer = "unicode61" | "trigram";

export function tokenizeFtsQuery(raw: string): string[] {
  return normalizeStringEntries(raw.match(/[\p{L}\p{N}_][\p{L}\p{M}\p{N}_]*/gu) ?? []);
}

export function buildFtsQuery(
  raw: string,
  canonicalTokenizer?: FtsCanonicalTokenizer,
): string | null {
  return buildMatchQueryFromTerms(tokenizeFtsQuery(raw), canonicalTokenizer);
}

function simpleCaseFold(character: string): string {
  const upper = character.toUpperCase();
  const folded = Array.from(upper).length === 1 ? upper.toLowerCase() : character.toLowerCase();
  // SQLite folds one code point to one code point. Full case expansions such
  // as Greek dialytika/tonos must not erase a distinct canonical query form.
  return Array.from(folded).length === 1 ? folded : character;
}

// Match sqlite3Fts5UnicodeIsdiacritic in SQLite ext/fts5/fts5_unicode2.c.
// Other combining marks are separators: dropping them can discard a necessary
// canonical alternative even though MATCH succeeds without finding a row.
const UNICODE61_DIACRITIC =
  /[\u0300-\u0304\u0306-\u030c\u030f\u0311\u031b\u0323-\u0328\u032d\u032e\u0330\u0331]/u;

function unicode61TokenizerKey(term: string): string {
  let key = "";
  for (const character of term) {
    if (UNICODE61_DIACRITIC.test(character)) {
      continue;
    }
    if (/\p{M}/u.test(character)) {
      key += " ";
      continue;
    }
    const decomposed = Array.from(character.normalize("NFD"));
    const base = decomposed[0];
    const foldedBase = base ? simpleCaseFold(base) : undefined;
    if (
      decomposed.length === 2 &&
      UNICODE61_DIACRITIC.test(decomposed[1] ?? "") &&
      foldedBase &&
      /^[a-z]$/u.test(foldedBase)
    ) {
      key += foldedBase;
      continue;
    }
    key += simpleCaseFold(character);
  }
  return key.replace(/ +/g, " ").trim();
}

function canonicalTermForms(term: string, tokenizer?: FtsCanonicalTokenizer): string[] {
  if (!tokenizer) {
    return [term];
  }
  const seen = new Set<string>();
  return [term, term.normalize("NFC"), term.normalize("NFD")].filter((form) => {
    const key =
      tokenizer === "unicode61"
        ? unicode61TokenizerKey(form)
        : Array.from(form, simpleCaseFold).join("");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function buildMatchQueryFromTerms(
  terms: string[],
  canonicalTokenizer?: FtsCanonicalTokenizer,
): string | null {
  if (terms.length === 0) {
    return null;
  }
  const quoted = terms.map((term) => {
    const forms = canonicalTermForms(term, canonicalTokenizer);
    const alternatives = forms.map((form) => `"${form.replaceAll('"', "")}"`);
    // Alternatives belong to each word: one document can mix NFC and NFD words.
    return alternatives.length === 1 ? alternatives[0] : `(${alternatives.join(" OR ")})`;
  });
  return quoted.join(" AND ");
}

export function planKeywordSearch(params: {
  query: string;
  ftsTokenizer?: "unicode61" | "trigram";
  includeCombiningMarks?: boolean;
  canonicalVariants?: boolean;
}): { matchQuery: string | null; substringTerms: string[] } {
  const canonicalTokenizer = params.canonicalVariants
    ? (params.ftsTokenizer ?? "unicode61")
    : undefined;
  if (params.ftsTokenizer !== "trigram") {
    const matchQuery = buildFtsQuery(params.query, canonicalTokenizer);
    return { matchQuery, substringTerms: [] };
  }
  const tokens = params.includeCombiningMarks
    ? normalizeStringEntries(params.query.match(/[\p{L}\p{M}\p{N}_]+/gu) ?? [])
    : tokenizeFtsQuery(params.query);
  const matchTerms: string[] = [];
  const substringTerms: string[] = [];
  for (const token of tokens) {
    const forms = canonicalTermForms(token, canonicalTokenizer);
    // MATCH cannot find fewer than three code points. A decomposed spelling
    // must not hide a short composed form from the normalized substring owner.
    if (forms.some((form) => Array.from(form).length < 3)) {
      substringTerms.push(token);
    } else {
      matchTerms.push(token);
    }
  }
  return {
    matchQuery: buildMatchQueryFromTerms(matchTerms, canonicalTokenizer),
    substringTerms,
  };
}

export function bm25RankToScore(rank: number): number {
  if (!Number.isFinite(rank)) {
    return 1 / (1 + 999);
  }
  if (rank < 0) {
    const relevance = -rank;
    return relevance / (1 + relevance);
  }
  return 1 / (1 + rank);
}
