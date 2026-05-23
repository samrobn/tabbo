<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, shallowRef, toRef } from 'vue'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, Decoration, type DecorationSet } from '@codemirror/view'
import { EditorState, Compartment, StateField, StateEffect } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { tab } from '../codemirror/tab-language'

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

// Create editor on mount
onMounted(() => {
  if (!editorContainer.value) return

  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      emit('update:modelValue', update.state.doc.toString())
    }
  })

  const startState = EditorState.create({
    doc: props.modelValue,
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      languageConf.of(tab()),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      errorLinesField,
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
        '&.cm-focused .cm-cursor': {
          borderLeftColor: '#3b82f6',
        },
        '&.cm-focused .cm-selectionBackground, ::selection': {
          backgroundColor: '#dbeafe',
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
  editorView.value?.destroy()
})
</script>

<template>
  <div class="h-full flex flex-col">
    <div class="px-4 py-2 bg-gray-50 border-b border-gray-200">
      <h2 class="text-sm font-medium text-gray-700">Tab Source</h2>
    </div>
    <div ref="editorContainer" class="flex-1 overflow-hidden"></div>
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
</style>
