import { Decoration, EditorView, GutterMarker, ViewPlugin, gutterLineClass } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder, StateField } from "@codemirror/state";
import type { RangeSet, Text } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { computeBarRuling } from "../../../shared/bar-ruling";

function buildDecorations(view: EditorView): DecorationSet {
  const doc = view.state.doc;
  const lineTexts: string[] = [];
  for (let n = 1; n <= doc.lines; n++) lineTexts.push(doc.line(n).text);
  const { barNumberByLine, altByLine } = computeBarRuling(lineTexts);

  const builder = new RangeSetBuilder<Decoration>();
  for (let n = 1; n <= doc.lines; n++) {
    const from = doc.line(n).from;
    const bar = barNumberByLine[n - 1];
    const alt = altByLine[n - 1];
    if (bar !== null) {
      builder.add(
        from,
        from,
        Decoration.line({
          class: alt ? "cm-barLine cm-barAlt" : "cm-barLine",
          attributes: { "data-bar": String(bar) },
        }),
      );
    } else if (alt) {
      builder.add(from, from, Decoration.line({ class: "cm-barAlt" }));
    }
  }
  return builder.finish();
}

const barRulerPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged) this.decorations = buildDecorations(update.view);
    }
  },
  { decorations: (instance) => instance.decorations },
);

// The gutter is a separate DOM tree from content lines, so the alternating
// tint needs its own gutter-line markers to span under the line numbers.
const barAltGutterMarker = new (class extends GutterMarker {
  elementClass = "cm-barAlt";
})();

function buildGutterMarkers(doc: Text): RangeSet<GutterMarker> {
  const lineTexts: string[] = [];
  for (let n = 1; n <= doc.lines; n++) lineTexts.push(doc.line(n).text);
  const { altByLine } = computeBarRuling(lineTexts);
  const builder = new RangeSetBuilder<GutterMarker>();
  for (let n = 1; n <= doc.lines; n++) {
    const from = doc.line(n).from;
    if (altByLine[n - 1]) builder.add(from, from, barAltGutterMarker);
  }
  return builder.finish();
}

const barAltGutterField = StateField.define<RangeSet<GutterMarker>>({
  create: (state) => buildGutterMarkers(state.doc),
  update: (value, tr) => (tr.docChanged ? buildGutterMarkers(tr.newDoc) : value),
  provide: (field) => gutterLineClass.from(field),
});

const barRulerTheme = EditorView.baseTheme({
  ".cm-barLine": { position: "relative", color: "var(--color-ink-faint)" },
  ".cm-barLine span": { color: "var(--color-ink-faint)" },
  ".cm-barLine::before": {
    content: "''",
    position: "absolute",
    left: "calc(12px + 3ch)",
    right: "46px",
    top: "50%",
    height: "1px",
    background: "var(--color-hairline)",
  },
  ".cm-barLine::after": {
    content: "attr(data-bar)",
    position: "absolute",
    right: "14px",
    top: "50%",
    transform: "translateY(-50%)",
    fontSize: "var(--numeral-size)",
    fontWeight: "var(--weight-mark)",
    letterSpacing: "var(--numeral-tracking)",
    color: "var(--color-ink-faint)",
  },
  ".cm-barAlt": { background: "rgba(255,255,255,0.016)" },
});

export function barRuler(): Extension {
  return [barRulerPlugin, barAltGutterField, barRulerTheme];
}
