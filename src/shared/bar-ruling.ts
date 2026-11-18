export interface BarRuling {
  barNumberByLine: (number | null)[];
  altByLine: boolean[];
}

// What counts as a barline line. The syntax highlighter imports this too, so
// the ruler and the highlighter can never disagree about what a barline is.
export const BARLINE = /^\.?[bB]+\.?(?![a-z])/;

export function computeBarRuling(lineTexts: string[]): BarRuling {
  const barNumberByLine: (number | null)[] = [];
  const altByLine: boolean[] = [];
  let bar = 1;
  for (const text of lineTexts) {
    if (BARLINE.test(text)) {
      barNumberByLine.push(bar);
      altByLine.push(bar % 2 === 0);
      bar += 1;
    } else {
      barNumberByLine.push(null);
      altByLine.push(bar % 2 === 0);
    }
  }
  return { barNumberByLine, altByLine };
}
