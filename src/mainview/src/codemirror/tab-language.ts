/**
 * CodeMirror 6 syntax highlighting for .tab lute tablature format.
 * Uses StreamLanguage for line-based parsing.
 */
import { StreamLanguage, LanguageSupport } from '@codemirror/language'
import { Tag } from '@lezer/highlight'

// Custom tags for tab-specific elements
const tabTags = {
  barline: Tag.define(),
  rhythmFlag: Tag.define(),
  ornament: Tag.define(),
  fretLetter: Tag.define(),
  courseNumber: Tag.define(),
  music: Tag.define(),
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

      // Barlines at start of line: b, bb, B, .bb., etc.
      if (stream.match(/^\.?[bB]+\.?(?![a-z])/)) {
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

export function tab(): LanguageSupport {
  return new LanguageSupport(tabLanguage)
}

export { tabLanguage, tabTags }
