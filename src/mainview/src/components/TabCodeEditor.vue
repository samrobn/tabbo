<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, shallowRef, nextTick } from 'vue'
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, drawSelection, Decoration, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { EditorState, Compartment, StateField, StateEffect, RangeSetBuilder } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { tab } from '../codemirror/tab-language'
import { search, setSearchQuery, getSearchQuery, SearchQuery, findNext, findPrevious } from '@codemirror/search'
import { currentMatchIndex, matchToSelect, type MatchRange } from '../../../shared/search-match'

interface Props {
  modelValue: string
  errorLines?: number[]
  fontSize?: number
}

const props = withDefaults(defineProps<Props>(), {
  errorLines: () => [],
  fontSize: 14,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const editorContainer = ref<HTMLElement | null>(null)
const editorView = shallowRef<EditorView | null>(null)
const languageConf = new Compartment()
const fontSizeConf = new Compartment()

const searchOpen = ref<boolean>(false)
const queryStr = ref<string>('')
const searchField = ref<HTMLInputElement | null>(null)
const matchCount = ref<{ current: number; total: number }>({ current: 0, total: 0 })
// Plain (non-reactive) document offset seeding where a query-change selects.
let searchAnchor = 0
// Detaches the in-flight blink-freeze mouseup listener; set while a drag is held,
// cleared on mouseup. Held here so onUnmounted can detach a listener still live
// if the component tears down mid-drag.
let detachBlinkFreeze: (() => void) | null = null

const countLabel = computed(() => {
  if (!queryStr.value) return ''
  const { current, total } = matchCount.value
  // current === 0 covers both no-matches (total 0 → '0') and a valid query with
  // the cursor not on a match (passive restore / after an edit → bare total).
  if (current === 0) return `${total}`
  return `${current} of ${total}`
})

function fontSizeTheme(size: number) {
  return EditorView.theme({
    '&': { fontSize: `${size}px` },
  })
}

// Error line highlighting
const setErrorLinesEffect = StateEffect.define<number[]>()

const errorLineMark = Decoration.line({ class: 'cm-errorLine' })

const errorLinesField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none
  },
  update(decorations, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setErrorLinesEffect)) {
        const lines = effect.value
        const builder: { from: number; to: number; value: Decoration }[] = []
        for (const lineNum of lines) {
          if (lineNum >= 1 && lineNum <= tr.state.doc.lines) {
            const line = tr.state.doc.line(lineNum)
            builder.push({ from: line.from, to: line.from, value: errorLineMark })
          }
        }
        return Decoration.set(builder.map(({ from, value }) => value.range(from)))
      }
    }
    return decorations.map(tr.changes)
  },
  provide: f => EditorView.decorations.from(f)
})

// All-matches highlighter. The built-in @codemirror/search highlighter is gated
// on its own panel being open, which we never open — so we provide our own.
// The active match gets a distinct class because Tabbo's selection colour is
// gated on editor focus, and the editor is unfocused while the search field has focus.
const searchMatchMark = Decoration.mark({ class: 'cm-searchMatch' })
const searchMatchSelectedMark = Decoration.mark({ class: 'cm-searchMatch cm-searchMatch-selected' })

const searchHighlighter = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = this.build(view) }
  update(update: ViewUpdate) {
    if (
      update.docChanged ||
      update.selectionSet ||
      update.viewportChanged ||
      getSearchQuery(update.state) !== getSearchQuery(update.startState)
    ) {
      this.decorations = this.build(update.view)
    }
  }
  build(view: EditorView): DecorationSet {
    const query = getSearchQuery(view.state)
    const builder = new RangeSetBuilder<Decoration>()
    if (!query.valid) return builder.finish()
    const sel = view.state.selection.main
    for (const { from, to } of view.visibleRanges) {
      const cursor = query.getCursor(view.state, from, to)
      let next = cursor.next()
      while (!next.done) {
        const match = next.value
        const isActive = match.from === sel.from && match.to === sel.to
        builder.add(match.from, match.to, isActive ? searchMatchSelectedMark : searchMatchMark)
        next = cursor.next()
      }
    }
    return builder.finish()
  }
}, { decorations: plugin => plugin.decorations })

// Active-line highlight only when the selection is empty. CM's stock
// highlightActiveLine always marks the head line; its opaque background sits
// in front of the z-index:-1 selection layer, so on a non-empty selection it
// would occlude the selection on that one line and tint it differently from
// the rest. Dropping the active line while selecting keeps every selected
// line the same colour.
const activeLineDeco = Decoration.line({ class: 'cm-activeLine' })
const activeLineWhenEmpty = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = this.build(view) }
  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet) this.decorations = this.build(update.view)
  }
  build(view: EditorView): DecorationSet {
    const main = view.state.selection.main
    if (!main.empty) return Decoration.none
    return Decoration.set([activeLineDeco.range(view.state.doc.lineAt(main.head).from)])
  }
}, { decorations: plugin => plugin.decorations })

function toggleSearch(): void {
  if (searchOpen.value) closeSearch()
  else openSearch()
}

function openSearch(): void {
  const view = editorView.value
  searchOpen.value = true
  if (view) {
    searchAnchor = view.state.selection.main.from
    if (queryStr.value) {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: queryStr.value, literal: true })) })
    }
    recompute()
  }
  nextTick(() => { searchField.value?.focus(); searchField.value?.select() })
}

function closeSearch(): void {
  const view = editorView.value
  searchOpen.value = false
  // Clear highlights + count, but keep queryStr so reopening restores it.
  view?.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: '' })) })
  matchCount.value = { current: 0, total: 0 }
  view?.focus()
}

// Whole-document match list (the engine's canonical non-overlapping tiling).
function enumerateMatches(view: EditorView): MatchRange[] {
  const query = getSearchQuery(view.state)
  const out: MatchRange[] = []
  if (!query.valid) return out
  const cursor = query.getCursor(view.state)
  let next = cursor.next()
  while (!next.done) {
    out.push({ from: next.value.from, to: next.value.to })
    next = cursor.next()
  }
  return out
}

function recompute(): void {
  const view = editorView.value
  if (!view) { matchCount.value = { current: 0, total: 0 }; return }
  const matches = enumerateMatches(view)
  const sel = view.state.selection.main
  matchCount.value = {
    total: matches.length,
    current: currentMatchIndex(matches, { from: sel.from, to: sel.to }),
  }
}

function navigate(direction: 'next' | 'prev'): void {
  const view = editorView.value
  // Guard: an empty/invalid query routes findNext/findPrevious through a
  // panel-opening fallback. No-op keeps the built-in panel from ever showing.
  if (!view || !queryStr.value) return
  // No matches → no-op. Without this the re-centre scroll below still fires and
  // jumps to the stale selection (the last prefix that matched while typing).
  if (matchCount.value.total === 0) return
  if (direction === 'next') findNext(view)
  else findPrevious(view)
  // findNext/findPrevious scroll "nearest", parking the match at the viewport
  // edge. Re-place it biased in the direction of travel — below centre when
  // stepping down, above centre when stepping up — so the path ahead stays in
  // view. `y: 'start'` puts the line top at `yMargin` px from the viewport top.
  const pos = view.state.selection.main.from
  const fraction = direction === 'next' ? 0.6 : 0.4
  view.dispatch({
    effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: view.scrollDOM.clientHeight * fraction }),
  })
  searchAnchor = pos
  // No explicit recompute: findNext/findPrevious moved the selection, so the
  // updateListener's selectionSet branch already refreshed the count.
}

function onQueryInput(): void {
  const view = editorView.value
  if (!view) return
  view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: queryStr.value, literal: true })) })
  if (queryStr.value) {
    const matches = enumerateMatches(view)
    const idx = matchToSelect(matches, searchAnchor)
    if (idx >= 0) {
      const match = matches[idx]
      // The selection move drives the count via updateListener's selectionSet branch.
      view.dispatch({ selection: { anchor: match.from, head: match.to }, scrollIntoView: true })
      return
    }
  }
  // Empty query or no match: nothing moved the selection, so refresh the count here.
  recompute()
}

defineExpose({ toggleSearch })

// Create editor on mount
onMounted(() => {
  if (!editorContainer.value) return

  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      emit('update:modelValue', update.state.doc.toString())
    }
    // Keep the count in step with the live selection while searching: a click or
    // arrow-key in the editor body moves the cursor off the active match, and the
    // count must follow (the highlighter already rebuilds on selectionSet).
    if (searchOpen.value && (update.docChanged || update.selectionSet)) recompute()
  })

  const startState = EditorState.create({
    doc: props.modelValue,
    extensions: [
      lineNumbers(),
      activeLineWhenEmpty,
      highlightActiveLineGutter(),
      // CM draws + manages its own cursor and hides the native caret (caret-color: transparent).
      // Without this, the native WebKit caret leaves repaint ghosts on type-then-delete in WKWebView.
      // drawRangeCursor:false hides the caret whenever the selection is
      // non-empty, so a drag-select shows no blinking cursor; it returns once
      // the selection collapses back to empty.
      drawSelection({ drawRangeCursor: false }),
      // Freeze the caret blink while the mouse button is held: CM drives the
      // blink via an inline animation on the cursor layer, so we tag the editor
      // root on mousedown and a CSS rule (with !important, to beat the inline
      // animation-name) stops the animation until mouseup.
      EditorView.domEventHandlers({
        mousedown: (_event, view) => {
          view.dom.classList.add('cm-mouse-down')
          const onUp = () => {
            view.dom.classList.remove('cm-mouse-down')
            window.removeEventListener('mouseup', onUp)
            detachBlinkFreeze = null
          }
          window.addEventListener('mouseup', onUp)
          detachBlinkFreeze = () => window.removeEventListener('mouseup', onUp)
          return false
        },
      }),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      languageConf.of(tab()),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      errorLinesField,
      search(),
      searchHighlighter,
      updateListener,
      EditorView.lineWrapping,
      fontSizeConf.of(fontSizeTheme(props.fontSize)),
      EditorView.theme({
        '&': {
          height: '100%',
        },
        '.cm-scroller': {
          fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
          overflow: 'auto',
        },
        '.cm-content': {
          padding: '12px 0',
        },
        '.cm-line': {
          padding: '0 12px',
        },
        '.cm-gutters': {
          backgroundColor: '#f8f9fa',
          borderRight: '1px solid #e5e7eb',
          color: '#9ca3af',
        },
        '.cm-activeLineGutter': {
          backgroundColor: '#e5e7eb',
        },
        '.cm-activeLine': {
          backgroundColor: '#f3f4f6',
        },
        '.cm-cursor, .cm-dropCursor': {
          borderLeftWidth: '2px',
        },
        '&.cm-focused .cm-cursor': {
          borderLeftColor: '#3b82f6',
        },
        // Stop the caret blink while the mouse button is held (see the
        // mousedown handler). !important beats CM's inline animation-name.
        '&.cm-mouse-down .cm-cursorLayer': {
          animationName: 'none !important',
        },
        '&.cm-focused .cm-selectionBackground, ::selection': {
          backgroundColor: '#dbeafe',
        },
        '.cm-searchMatch': {
          backgroundColor: '#fde68a',
        },
        '.cm-searchMatch-selected': {
          backgroundColor: '#fb923c',
        },
      }),
    ],
  })

  editorView.value = new EditorView({
    state: startState,
    parent: editorContainer.value,
  })
})

// Sync external changes to editor
watch(() => props.modelValue, (newValue) => {
  if (!editorView.value) return

  const currentValue = editorView.value.state.doc.toString()
  if (newValue !== currentValue) {
    editorView.value.dispatch({
      changes: {
        from: 0,
        to: currentValue.length,
        insert: newValue,
      },
    })
  }
})

// Sync font size to editor
watch(() => props.fontSize, (newSize) => {
  if (!editorView.value) return
  editorView.value.dispatch({
    effects: fontSizeConf.reconfigure(fontSizeTheme(newSize)),
  })
})

// Sync error lines to editor
watch(() => props.errorLines, (newErrorLines) => {
  if (!editorView.value) return

  editorView.value.dispatch({
    effects: setErrorLinesEffect.of(newErrorLines)
  })
}, { immediate: true })

// Cleanup on unmount
onUnmounted(() => {
  detachBlinkFreeze?.()
  editorView.value?.destroy()
})
</script>

<template>
  <div class="h-full flex flex-col">
    <div class="px-3 h-11 flex items-center bg-gray-50 border-b border-gray-200">
      <slot name="header" />
    </div>
    <div class="relative flex-1 overflow-hidden flex flex-col">
      <div ref="editorContainer" class="flex-1 overflow-hidden"></div>
      <div v-if="searchOpen" class="tab-search" @keydown.esc.stop.prevent="closeSearch">
        <div class="tab-search-field">
          <input
            ref="searchField"
            v-model="queryStr"
            class="tab-search-input"
            type="text"
            placeholder="Find"
            aria-label="Find in document"
            spellcheck="false"
            @input="onQueryInput"
            @keydown.enter.prevent="navigate(($event as KeyboardEvent).shiftKey ? 'prev' : 'next')"
            @keydown.down.prevent="navigate('next')"
            @keydown.up.prevent="navigate('prev')"
          />
          <span class="tab-search-count" aria-live="polite">{{ countLabel }}</span>
        </div>
        <button class="tab-search-btn" :disabled="!queryStr" @mousedown.prevent @click="navigate('prev')" aria-label="Previous match" title="Previous match">↑</button>
        <button class="tab-search-btn" :disabled="!queryStr" @mousedown.prevent @click="navigate('next')" aria-label="Next match" title="Next match">↓</button>
        <button class="tab-search-btn" @click="closeSearch" aria-label="Close search" title="Close">✕</button>
      </div>
    </div>
  </div>
</template>

<style>
/* Ensure CodeMirror fills the container */
.cm-editor {
  height: 100%;
}

/* Error line highlighting */
.cm-errorLine {
  background-color: #fef2f2 !important;
  border-left: 3px solid #ef4444;
}

.cm-editor .cm-line.cm-errorLine {
  background-color: #fef2f2;
}

.tab-search {
  position: absolute;
  top: 8px;
  right: 16px;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  background: #fff;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
}
.tab-search-field {
  position: relative;
  display: flex;
}
.tab-search-input {
  width: 12rem;
  font-size: 0.8rem;
  /* Right padding reserves the strip the match-count overlay sits in, so the
     count never affects the bar's width or the buttons' position. */
  padding: 3px 4rem 3px 6px;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  outline: none;
}
.tab-search-input:focus { border-color: #3b82f6; }
.tab-search-count {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 0.75rem;
  color: #6b7280;
  white-space: nowrap;
  pointer-events: none;
}
.tab-search-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.5rem;
  height: 1.5rem;
  font-size: 0.85rem;
  color: #374151;
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}
.tab-search-btn:hover:not(:disabled) { background: #f3f4f6; }
.tab-search-btn:disabled { color: #d1d5db; cursor: default; }
</style>
