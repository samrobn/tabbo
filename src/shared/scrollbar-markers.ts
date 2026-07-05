/**
 * Search-match → scrollbar-rail marker mapping (VS Code-style "overview
 * ruler"). Pure logic, zero CodeMirror/DOM dependency — the caller resolves
 * each match's line number and active state from live editor state, and
 * draws the returned rows (typically onto a canvas strip; see
 * TabCodeEditor.vue's search rail plugin).
 *
 * Position is derived from the match's line number relative to the
 * document's total line count, not pixel coordinates of (possibly
 * virtualised, unrendered) lines.
 */

export interface MatchLine {
  /** 1-based line number, as returned by CodeMirror's `doc.lineAt().number`. */
  line: number;
  /** Whether this is the current (selected) match. */
  active: boolean;
}

export interface ScrollbarMarker {
  /** Pixel offset from the top of the rail. */
  top: number;
  active: boolean;
}

/**
 * Maps each match to a pixel row on a rail of `railHeight` px tall, then
 * collapses matches landing on the same row into a single marker (a
 * collapsed row is active if any contributing match is active). Without
 * collapsing, a dense document could emit thousands of overlapping rows —
 * this keeps the marker count bounded by rail height, the acceptance
 * criterion for "no marker overlap artefacts on long documents".
 */
export function computeScrollbarMarkers(
  matches: MatchLine[],
  totalLines: number,
  railHeight: number,
): ScrollbarMarker[] {
  if (matches.length === 0 || totalLines <= 0 || railHeight <= 0) return [];

  const activeByRow = new Map<number, boolean>();
  for (const { line, active } of matches) {
    const row = Math.min(railHeight - 1, Math.floor((line / totalLines) * railHeight));
    activeByRow.set(row, (activeByRow.get(row) ?? false) || active);
  }

  return Array.from(activeByRow.entries())
    .sort(([rowA], [rowB]) => rowA - rowB)
    .map(([top, active]) => ({ top, active }));
}
