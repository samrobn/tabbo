<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, shallowRef, nextTick } from 'vue'
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, drawSelection, Decoration, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { EditorState, Compartment, StateField, StateEffect, RangeSetBuilder } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { tab } from '../codemirror/tab-language'
import { search, setSearchQuery, getSearchQuery, SearchQuery, findNext, findPrevious } from '@codemirror/search'
import { currentMatchIndex, matchToSelect, type MatchRange } from '../../../shared/search-match'
import { computeScrollbarMarkers, type MatchLine } from '../../../shared/scrollbar-markers'
import { scrollFraction, scrollTopForFraction, clampScrollTop, type ScrollPosition } from '../../../shared/scroll-sync'

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
  'scroll-position': [position: ScrollPosition]
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
// Active WKWebView focus-reveal guard (see the mousedown handler): scroll
// position to hold and the deadline it holds until. Null when disarmed.
const FOCUS_SCROLL_GUARD_MS = 250
let focusScrollGuard: { scrollTop: number; until: number } | null = null
// Detaches a pending scrollbar-refocus mouseup listener (see the focusin
// handler in onMounted); held so onUnmounted can clear one still in flight.
let detachRefocus: (() => void) | null = null

// Scroll sync: only the hovered pane emits scroll-position (loop prevention -
// a programmatic setScrollPosition write on the unhovered follower never
// re-emits). App.vue owns the enabled/disabled state and the other pane's ref.
//
// The editor always knows its own top visible line (CM6's line-block APIs
// don't depend on anchors), so it emits a real `line`, never null. The
// preview may emit null (no anchors/layout yet) - in that case we fall back
// to `fraction`.
const isHovered = ref<boolean>(false)
let onEditorScroll: (() => void) | null = null

// Fractional source line (1-based, may have a fractional part) currently at
// the top of the viewport. `lineBlockAtHeight` returns the block spanning
// that scroll height regardless of line-wrapping, so this stays accurate
// under EditorView.lineWrapping.
// CM6's lineBlockAtHeight/lineBlockAt report positions in document space,
// which excludes .cm-content's `padding: '12px 0'` (view.documentPadding.top);
// scrollDOM.scrollTop is measured in the scroller's space, which includes it.
// Every conversion between the two must add/subtract that padding.
function topVisibleLine(view: EditorView): number {
  const docScrollTop = Math.max(0, view.scrollDOM.scrollTop - view.documentPadding.top)
  const block = view.lineBlockAtHeight(docScrollTop)
  const lineNumber = view.state.doc.lineAt(block.from).number
  const fractionWithinBlock = block.height > 0 ? (docScrollTop - block.top) / block.height : 0
  return lineNumber + fractionWithinBlock
}

// Inverse of topVisibleLine: scrollTop that puts `fractionalLine` at the
// viewport top. The integer part selects the doc line (clamped to its valid
// range); the fractional remainder places the target within that line's
// block - both computed from the clamped line so out-of-range inputs pin to
// the boundary line's start/end rather than extrapolating past it.
function scrollTopForLine(view: EditorView, fractionalLine: number): number {
  const totalLines = view.state.doc.lines
  const clampedFractionalLine = Math.min(totalLines, Math.max(1, fractionalLine))
  const clampedLine = Math.floor(clampedFractionalLine)
  const withinLineFraction = clampedFractionalLine - clampedLine
  const block = view.lineBlockAt(view.state.doc.line(clampedLine).from)
  return block.top + withinLineFraction * block.height + view.documentPadding.top
}

function setScrollPosition(position: ScrollPosition): void {
  const view = editorView.value
  if (!view) return
  const target = position.line !== null
    ? scrollTopForLine(view, position.line)
    : scrollTopForFraction(position.fraction, view.scrollDOM.scrollHeight, view.scrollDOM.clientHeight)
  view.scrollDOM.scrollTop = clampScrollTop(target, view.scrollDOM.scrollHeight, view.scrollDOM.clientHeight)
}

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
  // Refocusing from the search field is the same WebKit focus-restore
  // transition the mousedown handler guards — pin the viewport so closing
  // search doesn't scroll back to an off-screen caret.
  if (view) {
    focusScrollGuard = { scrollTop: view.scrollDOM.scrollTop, until: performance.now() + FOCUS_SCROLL_GUARD_MS }
  }
  view?.focus()
}

// Whole-document match list (the engine's canonical non-overlapping tiling).
// Memoised on (doc, query) identity: both the scrollbar rail and recompute()
// run on the same triggers, so without the cache every keystroke with the
// widget open would scan a potentially huge document twice. Both are
// immutable, identity-stable objects (the highlighter already relies on
// getSearchQuery identity to detect query changes), so a plain === check is
// a sound cache key. Per-component-instance state is unnecessary — the cache
// self-corrects on any doc/query difference, so instances can share it.
let matchCache: { doc: unknown; query: SearchQuery; matches: MatchRange[] } | null = null
function enumerateMatches(view: EditorView): MatchRange[] {
  const query = getSearchQuery(view.state)
  const doc = view.state.doc
  if (matchCache && matchCache.doc === doc && matchCache.query === query) return matchCache.matches
  const out: MatchRange[] = []
  if (query.valid) {
    const cursor = query.getCursor(view.state)
    let next = cursor.next()
    while (!next.done) {
      out.push({ from: next.value.from, to: next.value.to })
      next = cursor.next()
    }
  }
  matchCache = { doc, query, matches: out }
  return out
}

// Search-match scrollbar rail (VS Code-style "overview ruler"). A canvas
// strip pinned to the editor's right edge, not the OS scrollbar track
// itself (macOS overlay scrollbars only draw during scroll; the rail must
// stay visible regardless). Canvas over one DOM element per match keeps
// dense documents cheap — computeScrollbarMarkers collapses same-pixel-row
// matches before anything is drawn, so a match-dense document never smears
// the rail or stacks thousands of overlapping nodes.
const SEARCH_RAIL_WIDTH = 7
// amber-500 / orange-600 (Tailwind) — task 20260630-AF8M: the previous
// amber-200/orange-400 pair read as barely-visible pastel against the
// light editor background. These hold VS Code overview-ruler-style weight
// at a glance while keeping the active match clearly darker/stronger.
const SEARCH_RAIL_MATCH_COLOR = '#f59e0b'
const SEARCH_RAIL_ACTIVE_COLOR = '#ea580c'

const searchScrollbarRail = ViewPlugin.fromClass(class {
  canvas: HTMLCanvasElement
  constructor(view: EditorView) {
    this.canvas = document.createElement('canvas')
    this.canvas.className = 'cm-searchRail'
    view.dom.appendChild(this.canvas)
    this.draw(view)
  }
  update(update: ViewUpdate) {
    // Query change covers open/close (close sets the query to '', which
    // enumerateMatches treats as invalid → no matches → rail clears) and
    // query edits; docChanged/selectionSet cover edits and active-match
    // changes; geometryChanged covers resizes changing the rail's pixel height.
    if (
      update.docChanged ||
      update.selectionSet ||
      update.geometryChanged ||
      getSearchQuery(update.state) !== getSearchQuery(update.startState)
    ) {
      this.draw(update.view)
    }
  }
  draw(view: EditorView): void {
    const height = view.dom.clientHeight
    const dpr = window.devicePixelRatio || 1
    this.canvas.style.height = `${height}px`
    this.canvas.width = SEARCH_RAIL_WIDTH * dpr
    this.canvas.height = Math.max(height, 1) * dpr
    const ctx = this.canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    const matches = enumerateMatches(view)
    if (matches.length === 0) return
    const sel = view.state.selection.main
    const totalLines = view.state.doc.lines
    const matchLines: MatchLine[] = matches.map((match) => ({
      line: view.state.doc.lineAt(match.from).number,
      active: match.from === sel.from && match.to === sel.to,
    }))
    const markers = computeScrollbarMarkers(matchLines, totalLines, height)
    ctx.save()
    ctx.scale(dpr, dpr)
    for (const marker of markers) {
      ctx.fillStyle = marker.active ? SEARCH_RAIL_ACTIVE_COLOR : SEARCH_RAIL_MATCH_COLOR
      ctx.fillRect(1, marker.top, SEARCH_RAIL_WIDTH - 2, 2)
    }
    ctx.restore()
  }
  destroy(): void {
    this.canvas.remove()
  }
})

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

defineExpose({ toggleSearch, setScrollPosition })

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
        mousedown: (event, view) => {
          // WKWebView asynchronously scrolls the editor back to the previous
          // caret ~10ms after a mousedown refocuses the content (an async
          // selection reveal that CM's focusPreventScroll can't suppress —
          // preventScroll only covers the focus call itself). Pin the scroll
          // position for a short window so the reveal is snapped back before
          // CM's drag-tracking turns it into a runaway selection. Text-area
          // mousedowns only: arming on scrollbar grabs would fight the drag.
          if (!view.hasFocus && view.contentDOM.contains(event.target as Node)) {
            focusScrollGuard = { scrollTop: view.scrollDOM.scrollTop, until: performance.now() + FOCUS_SCROLL_GUARD_MS }
            // WebKit also restores the editable's previous DOM selection on
            // refocus; CM's observer reads that mid-click and extends the
            // selection to the old caret (shift-click effect). Pre-seat the
            // DOM selection at the click point so the restore is a no-op —
            // except on a real shift-click, where extending from the old
            // caret is exactly what the user is asking for (and pre-seating
            // would collapse the anchor CM extends from).
            if (!event.shiftKey) {
              const caretRange = document.caretRangeFromPoint?.(event.clientX, event.clientY)
              if (caretRange) {
                const domSelection = window.getSelection()
                domSelection?.removeAllRanges()
                domSelection?.addRange(caretRange)
              }
            }
          }
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
      searchScrollbarRail,
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

  onEditorScroll = () => {
    if (!isHovered.value) return
    const view = editorView.value
    if (!view) return
    emit('scroll-position', {
      line: topVisibleLine(view),
      fraction: scrollFraction(view.scrollDOM.scrollTop, view.scrollDOM.scrollHeight, view.scrollDOM.clientHeight),
    })
  }
  editorView.value.scrollDOM.addEventListener('scroll', onEditorScroll)

  // Enforce the WKWebView focus-reveal guard armed in the mousedown handler:
  // any scroll away from the pinned position inside the guard window is
  // snapped straight back. The corrective write re-fires this listener with a
  // zero delta, so it settles immediately. A wheel gesture disarms — that's
  // the user genuinely scrolling.
  const guardedScroller = editorView.value.scrollDOM
  guardedScroller.addEventListener('scroll', () => {
    if (!focusScrollGuard) return
    if (performance.now() > focusScrollGuard.until) {
      focusScrollGuard = null
      return
    }
    if (Math.abs(guardedScroller.scrollTop - focusScrollGuard.scrollTop) > 1) {
      guardedScroller.scrollTop = focusScrollGuard.scrollTop
    }
  })
  guardedScroller.addEventListener('wheel', () => { focusScrollGuard = null }, { passive: true })

  // Grabbing the scrollbar moves focus off the content editable (WebKit makes
  // scrollable regions click-focusable), which primes the focus-restore
  // misbehaviour on the next click — jump to the old caret, or a stolen
  // shift-click extension. Hand focus back to the content when the scrollbar
  // interaction ends, with the guard armed to eat the restore's reveal scroll.
  const editorRoot = editorView.value.dom
  const editorContent = editorView.value.contentDOM
  editorRoot.addEventListener('focusin', (event) => {
    const target = event.target as Node
    if (target === editorContent || editorContent.contains(target)) return
    detachRefocus?.()
    const refocusContent = () => {
      window.removeEventListener('mouseup', refocusContent)
      detachRefocus = null
      focusScrollGuard = { scrollTop: guardedScroller.scrollTop, until: performance.now() + FOCUS_SCROLL_GUARD_MS }
      editorContent.focus({ preventScroll: true })
    }
    window.addEventListener('mouseup', refocusContent)
    detachRefocus = () => window.removeEventListener('mouseup', refocusContent)
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
  detachRefocus?.()
  if (onEditorScroll) editorView.value?.scrollDOM.removeEventListener('scroll', onEditorScroll)
  editorView.value?.destroy()
})
</script>

<template>
  <div class="h-full flex flex-col">
    <div class="px-3 h-11 flex items-center bg-gray-50 border-b border-gray-200">
      <slot name="header" />
    </div>
    <div class="relative flex-1 overflow-hidden flex flex-col" @mouseenter="isHovered = true" @mouseleave="isHovered = false">
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

/* Search-match scrollbar rail: fixed to the editor's right edge (not the OS
   scrollbar track), so it stays visible under macOS overlay scrollbars,
   which only render during an active scroll gesture. */
.cm-searchRail {
  position: absolute;
  top: 0;
  right: 2px;
  width: 7px;
  pointer-events: none;
  z-index: 2;
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
