export interface BarRuling {
  barNumberByLine: (number | null)[];
  altByLine: boolean[];
}

// The tokenizer's barline rule, verbatim (src/mainview/src/codemirror/tab-language.ts:83).
// The ruler and the syntax highlighter must never disagree about what a barline is.
const BARLINE = /^\.?[bB]+\.?(?![a-z])/;

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
