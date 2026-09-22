import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";

type FtsCanonicalTokenizer = "unicode61" | "trigram";

export type FtsQueryBuilder = (
  raw: string,
  canonicalTokenizer?: FtsCanonicalTokenizer,
) => string | null;

export function tokenizeFtsQuery(raw: string): string[] {
  return normalizeStringEntries(raw.match(/[\p{L}\p{N}_][\p{L}\p{M}\p{N}_]*/gu) ?? []);
}

export function buildFtsQuery(
  raw: string,
  canonicalTokenizer?: FtsCanonicalTokenizer,
): string | null {
  return buildMatchQueryFromTerms(tokenizeFtsQuery(raw), canonicalTokenizer);
}

// unicode61 keeps a legacy exception for precomposed Latin characters with
// multiple marks. Collapse only forms it actually tokenizes identically.
function unicode61FoldsCanonicalLatinForms(term: string): boolean {
  return Array.from(term.normalize("NFC")).every((character) => {
    if (!/\p{L}/u.test(character)) {
      return true;
    }
    const markCount = character.normalize("NFD").match(/\p{M}/gu)?.length ?? 0;
    return /\p{Script=Latin}/u.test(character) && markCount <= 1;
  });
}

function canonicalTermForms(term: string, tokenizer?: FtsCanonicalTokenizer): string[] {
  if (!tokenizer) {
    return [term];
  }
  return [...new Set([term, term.normalize("NFC"), term.normalize("NFD")])];
}

export function buildMatchQueryFromTerms(
  terms: string[],
  canonicalTokenizer?: FtsCanonicalTokenizer,
): string | null {
  if (terms.length === 0) {
    return null;
  }
  const quoted = terms.map((term) => {
    const forms =
      canonicalTokenizer === "unicode61" && unicode61FoldsCanonicalLatinForms(term)
        ? [term]
        : canonicalTermForms(term, canonicalTokenizer);
    const alternatives = forms.map((form) => `"${form.replaceAll('"', "")}"`);
    // Alternatives belong to each word: one document can mix NFC and NFD words.
    return alternatives.length === 1 ? alternatives[0] : `(${alternatives.join(" OR ")})`;
  });
  return quoted.join(" AND ");
}

export function planKeywordSearch(params: {
  query: string;
  ftsTokenizer?: "unicode61" | "trigram";
  buildFtsQuery: FtsQueryBuilder;
  includeCombiningMarks?: boolean;
  canonicalVariants?: boolean;
}): { matchQuery: string | null; substringTerms: string[] } {
  const canonicalTokenizer = params.canonicalVariants
    ? (params.ftsTokenizer ?? "unicode61")
    : undefined;
  if (params.ftsTokenizer !== "trigram") {
    const matchQuery = params.buildFtsQuery(params.query, canonicalTokenizer);
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
