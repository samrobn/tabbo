/**
 * CodeMirror 6 syntax highlighting for .tab lute tablature format.
 * Uses StreamLanguage for line-based parsing.
 */
import { StreamLanguage, LanguageSupport, forceParsing, syntaxTreeAvailable } from '@codemirror/language'
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view'
import { BARLINE } from '../../../shared/bar-ruling'
import { HIGHLIGHT_FILL } from '../../../shared/layout-render'
import { Tag } from '@lezer/highlight'

// Custom tags for tab-specific elements
const tabTags = {
  barline: Tag.define(),
  rhythmFlag: Tag.define(),
  ornament: Tag.define(),
  fretLetter: Tag.define(),
  courseNumber: Tag.define(),
  music: Tag.define(),
  // Q/@ editorial highlight. Its colour depends on document-wide flags, so the
  // editor picks it (editorialColour), not the tokenizer. Barlines are separate:
  // the engine never draws them as parens.
  editorial: Tag.define(),
  editorialBarline: Tag.define(),
}

interface TabState {
  inTextBlock: boolean
  textBlockChar: string | null
  inGrid: boolean
}

const tabLanguage = StreamLanguage.define<TabState>({
  name: 'tab',

  startState(): TabState {
    return {
      inTextBlock: false,
      textBlockChar: null,
      inGrid: false,
    }
  },

  tokenTable: {
    editorial: tabTags.editorial,
    editorialBarline: tabTags.editorialBarline,
  },

  token(stream, state): string | null {
    // Handle text blocks { ... } or [ ... }
    if (state.inTextBlock) {
      if (stream.match(/.*?}/)) {
        state.inTextBlock = false
        state.textBlockChar = null
        return 'string'
      }
      stream.skipToEnd()
      return 'string'
    }

    // Start of line checks
    if (stream.sol()) {
      // Comments: % to end of line
      if (stream.match(/%/)) {
        stream.skipToEnd()
        return 'comment'
      }

      // Text block start: { or [
      if (stream.match(/[{\[]/)) {
        state.inTextBlock = true
        state.textBlockChar = stream.current()
        // Check for immediate close
        if (stream.match(/[^}]*}/)) {
          state.inTextBlock = false
          state.textBlockChar = null
        }
        return 'string'
      }

      // Directives: -flag at line start (but not just -)
      if (stream.match(/-[a-zA-Z0-9]/)) {
        stream.match(/[^\s]*/) // consume rest of directive
        return 'keyword'
      }

      // Settings: $name=value
      if (stream.match(/\$/)) {
        stream.match(/[^=\s]+/)
        if (stream.match(/=/)) {
          stream.match(/[^\s]+/)
        }
        return 'keyword'
      }

      // Highlighted barline: as the engine (dvi_f.cc), a Q or L anywhere in
      // the barline's token marks it, and a '!' cancels the mark
      const barToken = BARLINE.test(stream.string) ? /^\S+/.exec(stream.string)?.[0] : undefined
      if (barToken && /[QL]/.test(barToken) && !barToken.includes('!') && stream.match(barToken)) {
        return 'editorialBarline'
      }

      // Barlines at start of line: b, bb, B, .bb., etc.
      if (stream.match(BARLINE)) {
        return 'keyword'
      }

      // End of document
      if (stream.match(/^e$/)) {
        return 'keyword'
      }

      // Page break
      if (stream.match(/^p$/)) {
        return 'keyword'
      }

      // Time signature
      if (stream.match(/^S[0-9C|]/)) {
        stream.match(/[0-9\-|CQOoi]*/)
        return 'atom'
      }

      // Rest
      if (stream.match(/^R[0-6!]?/)) {
        return 'atom'
      }

      // Fermata
      if (stream.match(/^[Yy]/)) {
        return 'atom'
      }

      // Grid start
      if (stream.match(/^[#|]/)) {
        state.inGrid = true
        return 'bracket'
      }

      // Triplet start
      if (stream.match(/^t[0-6]/)) {
        return 'bracket'
      }

      // Highlighted rhythm flag: 1Q, 2@
      if (stream.match(/^[Ww0-6x][Q@]/)) {
        return 'editorial'
      }

      // Rhythm flags at start: W, w, 0-6, x
      if (stream.match(/^[Ww0-6x][.!*|tWQB@]?/)) {
        return 'number'
      }

      // Music notation: M followed by flag, note, modifier
      if (stream.match(/^M[GF0-6WwZR]/)) {
        stream.match(/[A-Ga-g1-4?@][+\-.n^vN0#x=]?/)
        return 'className'
      }

      // Key signature
      if (stream.match(/^k[gdfcbea]/)) {
        return 'atom'
      }
    }

    // Within-line tokens

    // Ornaments (operators before/after notes)
    if (stream.match(/[&!"]/)) {
      // Postfix, prefix, escape operators
      stream.match(/[+*#x$<=>'`,^%?@_\-~\/\\;]/)
      return 'operator'
    }

    // Ornament characters
    if (stream.match(/[+*#$<=>'^`,_@%?;]/)) {
      return 'operator'
    }

    // Left-hand fingerings \1 \2 \3 \4
    if (stream.match(/\\[1-4]/)) {
      return 'meta'
    }

    // Slashes for bourdons
    if (stream.match(/\/+/)) {
      return 'meta'
    }

    // Underline markers [ ] ( ) { }
    if (stream.match(/[\[\](){}]/)) {
      return 'bracket'
    }

    // Tab fret letters a-p (lowercase)
    if (stream.match(/[a-p]/)) {
      return 'variableName'
    }

    // Italian numbers/fingerings
    if (stream.match(/[0-9]/)) {
      return 'number'
    }

    // Special characters: z (zero), w/u (hold)
    if (stream.match(/[zwu]/)) {
      return 'variableName'
    }

    // Fingering dots and strokes
    if (stream.match(/[.:|\-]/)) {
      return 'punctuation'
    }

    // Music in chord: M followed by info
    if (stream.match(/M[0-6WwZGFR]/)) {
      stream.match(/[A-Ga-g1-4?@][+\-.n^vN0#x=\-]?/)
      return 'className'
    }

    // Text marker: T followed by text
    if (stream.match(/T[^\t\n]*/)) {
      return 'string'
    }

    // Skip whitespace
    if (stream.match(/\s+/)) {
      return null
    }

    // Consume unknown character
    stream.next()
    return null
  },

  languageData: {
    commentTokens: { line: '%' },
  },
})

// CodeMirror parses in the background only ~100k characters past the viewport,
// and without requestIdleCallback (WKWebView has none) each resumed parse waits
// up to 500ms - so scrolling far into a long score showed unstyled lines for
// half a second. Once typing pauses, parse to the end of the document in short
// slices so the whole score is already highlighted when it is scrolled to.
const PARSE_AHEAD_DELAY_MS = 300
const PARSE_SLICE_MS = 20

export const parseToEnd = ViewPlugin.fromClass(class {
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly view: EditorView) {
    this.schedule(PARSE_AHEAD_DELAY_MS)
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) this.schedule(PARSE_AHEAD_DELAY_MS)
  }

  destroy(): void {
    clearTimeout(this.timer)
  }

  private schedule(delay: number): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.step(), delay)
  }

  private step(): void {
    const end = this.view.state.doc.length
    if (syntaxTreeAvailable(this.view.state, end)) return
    forceParsing(this.view, end, PARSE_SLICE_MS)
    this.schedule(0)
  }
})

// The colours the engine gives Q/@ marks, from the document's flags, which
// apply wherever in the file they appear: red under -highlightred, grey
// otherwise. -highlightparen draws flags and notes as uncoloured parens (it
// wins over red), but barlines ignore it.
export function editorialColours(doc: string): { mark: string | null; barline: string } {
  // Only flag lines (starting with '-') set flags; a % comment or a title that
  // mentions one doesn't.
  const flagLines = doc.split('\n').filter((line) => line.startsWith('-')).join('\n')
  const barline = /(^|\s)-highlightred\b/m.test(flagLines) ? HIGHLIGHT_FILL.red : HIGHLIGHT_FILL.gray
  return { mark: /(^|\s)-highlightparen\b/m.test(flagLines) ? null : barline, barline }
}

export function tab(): LanguageSupport {
  return new LanguageSupport(tabLanguage, [parseToEnd])
}

export { tabLanguage, tabTags }
