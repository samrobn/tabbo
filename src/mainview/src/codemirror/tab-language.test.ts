import { describe, expect, test } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { ensureSyntaxTree, syntaxTreeAvailable } from '@codemirror/language'
import { editorialColours, tab } from './tab-language'

// A score long enough that its end lies well past CodeMirror's own parse-ahead limit.
const CHORD_LINES = '1-abc dDo\n2-efg hG\nb\n'
const LONG_SCORE = '{Long score}\n' + CHORD_LINES.repeat(12_000) + 'e\n'

describe('tab language parse-ahead', () => {
  test('a long score is parsed to its end once typing pauses, without scrolling there', async () => {
    const view = new EditorView({
      state: EditorState.create({ doc: LONG_SCORE, extensions: [tab()] }),
      parent: document.body,
    })
    try {
      expect(LONG_SCORE.length).toBeGreaterThan(200_000)
      expect(syntaxTreeAvailable(view.state, view.state.doc.length)).toBe(false)
      const deadline = Date.now() + 5_000
      while (!syntaxTreeAvailable(view.state, view.state.doc.length) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(syntaxTreeAvailable(view.state, view.state.doc.length)).toBe(true)
    } finally {
      view.destroy()
    }
  }, 10_000)
})

function tokensOf(doc: string): string[] {
  const state = EditorState.create({ doc, extensions: [tab()] })
  const names: string[] = []
  ensureSyntaxTree(state, doc.length, 1_000)!.iterate({
    enter: (node) => {
      if (node.from < node.to && node.name !== 'Document') names.push(`${doc.slice(node.from, node.to)}:${node.name}`)
    },
  })
  return names
}

describe('tab language editorial highlights', () => {
  test('Q/@ on a rhythm flag, and Q or L in a barline, mark it as the engine does', () => {
    expect(tokensOf('1Qcdda\n2@cce\nbQ\nbL\nb\n1a\n')).toEqual([
      '1Q:editorial', 'cdda:variableName', '2@:editorial', 'cce:variableName',
      'bQ:editorialBarline', 'bL:editorialBarline', 'b:keyword', '1:number', 'a:variableName',
    ])
  })

  test('a barline with @, or with ! cancelling the mark, is a plain barline', () => {
    expect(tokensOf('b@\nbQ!\n')[0]).toBe('b:keyword')
    expect(tokensOf('bQ!\n')[0]).toBe('b:keyword')
  })

  test('the mark colour follows document-wide flags wherever they appear', () => {
    expect(editorialColours('1Qa\n')).toEqual({ mark: '#808080', barline: '#808080' })
    expect(editorialColours('1Qa\n-twostaff -highlightred\n')).toEqual({ mark: '#ff0000', barline: '#ff0000' })
    // Paren beats red for flags and notes, but barlines never take parens
    expect(editorialColours('-highlightred\n-highlightparen\n1Qa\n')).toEqual({ mark: null, barline: '#ff0000' })
    expect(editorialColours('-highlightparen\nbQ\n')).toEqual({ mark: null, barline: '#808080' })
    // A flag mentioned in a comment or title isn't set
    expect(editorialColours('% -highlightred (off for print)\n{-highlightparen}\n1Qa\n')).toEqual({ mark: '#808080', barline: '#808080' })
  })
})
