export interface MatchRange {
  from: number;
  to: number;
}

/**
 * 1-based index (within `matches`) of the range exactly equal to `selection`
 * by both `from` and `to`; 0 when the selection is not on an enumerated match
 * (e.g. just after open, before any navigation). Matching on both endpoints
 * (not `from` alone) keeps the index correct for self-overlapping queries
 * whose selection may not lie on the canonical non-overlapping tiling.
 */
export function currentMatchIndex(matches: MatchRange[], selection: MatchRange): number {
  const matchIndex = matches.findIndex((range) => range.from === selection.from && range.to === selection.to);
  return matchIndex === -1 ? 0 : matchIndex + 1;
}

/**
 * Index into `matches` of the match to select for a query change: the first
 * match starting at or after `anchor`, wrapping to the first match when none
 * is at/after the anchor. Returns -1 when `matches` is empty.
 */
export function matchToSelect(matches: MatchRange[], anchor: number): number {
  if (matches.length === 0) return -1;
  const matchIndex = matches.findIndex((range) => range.from >= anchor);
  return matchIndex === -1 ? 0 : matchIndex;
}
