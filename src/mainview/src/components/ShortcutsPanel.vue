<script setup lang="ts">
defineProps<{
  isOpen: boolean
}>()

const emit = defineEmits<{
  close: []
}>()

// Static inventory of the app's shortcuts. Menu accelerators are defined
// bun-side (src/bun/menu.ts) - keep the two in sync when adding shortcuts.
const sections = [
  {
    title: 'File',
    items: [
      { keys: '⌘N', description: 'New document' },
      { keys: '⌘O', description: 'Open…' },
      { keys: '⌘S', description: 'Save' },
      { keys: '⇧⌘E', description: 'Export PDF' },
      { keys: '⌘W', description: 'Close window' },
      { keys: '⌘Q', description: 'Quit Tabbo' },
    ]
  },
  {
    title: 'Editing',
    items: [
      { keys: '⌘Z', description: 'Undo' },
      { keys: '⇧⌘Z', description: 'Redo' },
      { keys: '⌘X / ⌘C / ⌘V', description: 'Cut / Copy / Paste' },
      { keys: '⌘A', description: 'Select all' },
      { keys: '⌘/', description: 'Toggle comment' },
    ]
  },
  {
    title: 'Find',
    items: [
      { keys: '⌘F', description: 'Find in document' },
      { keys: '↩', description: 'Next match' },
      { keys: '⇧↩', description: 'Previous match' },
      { keys: 'esc', description: 'Close find bar' },
    ]
  },
  {
    title: 'Help',
    items: [
      { keys: '⇧⌘/', description: 'Keyboard shortcuts (this panel)' },
    ]
  },
]
</script>

<template>
  <Teleport to="body">
    <Transition name="overlay">
      <div
        v-if="isOpen"
        class="fixed inset-0 z-50 flex items-start justify-end"
        @click.self="emit('close')"
      >
        <!-- Backdrop -->
        <div class="absolute inset-0 bg-scrim-soft" @click="emit('close')"></div>

        <!-- Panel -->
        <div class="side-panel max-w-sm">
          <!-- Header -->
          <div class="flex items-center justify-between shrink-0 h-11 px-4 border-b border-hairline bg-head">
            <h2 class="surface-title">Keyboard Shortcuts</h2>
            <button
              @click="emit('close')"
              class="p-1 text-ink-soft hover:text-ink hover:bg-raise rounded-control transition-colors"
              title="Close"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <!-- Content -->
          <div class="flex-1 overflow-y-auto p-4 space-y-6">
            <div v-for="section in sections" :key="section.title">
              <h3 class="eyebrow mb-2">
                {{ section.title }}
              </h3>
              <div class="space-y-1">
                <div
                  v-for="item in section.items"
                  :key="item.description"
                  class="flex items-center justify-between gap-3 py-1"
                >
                  <span class="text-sm text-ink-soft">{{ item.description }}</span>
                  <kbd class="flex-shrink-0 px-2 py-0.5 bg-head text-ink border border-hairline rounded-control text-sm font-mono whitespace-nowrap">
                    {{ item.keys }}
                  </kbd>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
