<script setup lang="ts">
defineProps<{
  isOpen: boolean
}>()

const emit = defineEmits<{
  close: []
}>()

const sections = [
  {
    title: 'Document Structure',
    items: [
      { syntax: 'e', description: 'End of document (required)' },
      { syntax: '% comment', description: 'Comment line' },
      { syntax: '{ text }', description: 'Text block (title, lyrics)' },
      { syntax: 'b', description: 'Barline' },
      { syntax: 'bb', description: 'Double barline' },
      { syntax: '.bb.', description: 'Repeat barline' },
      { syntax: '(blank line)', description: 'Line break' },
      { syntax: 'p', description: 'Page break' },
    ]
  },
  {
    title: 'Rhythm Flags',
    items: [
      { syntax: 'W', description: 'Whole note' },
      { syntax: 'w', description: 'Half note' },
      { syntax: '0', description: 'No flag (semibreve)' },
      { syntax: '1', description: 'One flag (minim)' },
      { syntax: '2', description: 'Two flags (crotchet)' },
      { syntax: '3', description: 'Three flags (quaver)' },
      { syntax: '4', description: 'Four flags (semiquaver)' },
      { syntax: '5', description: 'Five flags (demisemiquaver)' },
      { syntax: '.', description: 'Dotted (after flag number)' },
      { syntax: 'x', description: 'Same flags as previous' },
    ]
  },
  {
    title: 'Tablature Characters',
    items: [
      { syntax: 'a-p', description: 'Fret letters (a=open, b=1st fret, etc.)' },
      { syntax: '1-9', description: 'Italian style fret numbers' },
      { syntax: 'space', description: 'Unplayed string' },
      { syntax: 'z', description: 'Zero (open string in Italian)' },
      { syntax: '#', description: 'Start of grid (chord)' },
      { syntax: '#2, #3', description: 'Grid with specified notes' },
    ]
  },
  {
    title: 'Ornaments',
    items: [
      { syntax: '+', description: 'Cross ornament' },
      { syntax: '*', description: 'Dot ornament' },
      { syntax: '#', description: 'Hash ornament' },
      { syntax: 'x', description: 'X ornament' },
      { syntax: '~', description: 'Tilde/vibrato' },
      { syntax: '&+, &*', description: 'Postfix ornaments' },
    ]
  },
  {
    title: 'Bass Strings',
    items: [
      { syntax: '/', description: 'Single slash (bourdon)' },
      { syntax: '//', description: 'Double slash' },
      { syntax: '///', description: 'Triple slash' },
      { syntax: '1-7', description: 'Bass string numbers' },
    ]
  },
  {
    title: 'Directives ($)',
    items: [
      { syntax: '$flagstyle=X', description: 'Set flag style (standard, italian, thin)' },
      { syntax: '$numstyle=X', description: 'Set number style (standard, italian)' },
      { syntax: '$tuning=X', description: 'Set tuning' },
      { syntax: '$titlefont=X', description: 'Set title font' },
      { syntax: '$textsize=N', description: 'Set text size in points' },
    ]
  },
  {
    title: 'Time Signatures',
    items: [
      { syntax: 'S3', description: 'Time signature (3)' },
      { syntax: 'S3-4', description: 'Time signature (3/4)' },
      { syntax: 'SC', description: 'Common time (C)' },
    ]
  },
  {
    title: 'Command Line Options',
    items: [
      { syntax: '-pdf', description: 'Generate PDF output' },
      { syntax: '-i', description: 'Italian style' },
      { syntax: '-b', description: 'Baroque tuning' },
      { syntax: '-m', description: 'Piano version' },
      { syntax: '-v', description: 'Verbose output' },
    ]
  }
]
</script>

<template>
  <Teleport to="body">
    <Transition name="help-panel">
      <div
        v-if="isOpen"
        class="fixed inset-0 z-50 flex items-start justify-end"
        @click.self="emit('close')"
      >
        <!-- Backdrop -->
        <div class="absolute inset-0 bg-black/20" @click="emit('close')"></div>

        <!-- Panel -->
        <div class="relative h-full w-full max-w-md bg-white shadow-xl overflow-hidden flex flex-col">
          <!-- Header -->
          <div class="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50">
            <h2 class="text-lg font-semibold text-gray-800">.tab Syntax Reference</h2>
            <button
              @click="emit('close')"
              class="p-1 text-gray-500 hover:text-gray-700 hover:bg-gray-200 rounded transition-colors"
              title="Close"
            >
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <!-- Content -->
          <div class="flex-1 overflow-y-auto p-4 space-y-6">
            <div v-for="section in sections" :key="section.title">
              <h3 class="text-sm font-semibold text-gray-700 mb-2 uppercase tracking-wide">
                {{ section.title }}
              </h3>
              <div class="space-y-1">
                <div
                  v-for="item in section.items"
                  :key="item.syntax"
                  class="flex items-start gap-3 py-1"
                >
                  <code class="flex-shrink-0 px-2 py-0.5 bg-gray-100 text-blue-700 rounded text-sm font-mono min-w-[4rem] text-center">
                    {{ item.syntax }}
                  </code>
                  <span class="text-sm text-gray-600">{{ item.description }}</span>
                </div>
              </div>
            </div>

            <!-- Footer -->
            <div class="pt-4 border-t border-gray-200">
              <p class="text-xs text-gray-500">
                Based on the original Tab typesetter by Wayne Cripps.
                <a
                  href="https://www.cs.dartmouth.edu/~wbc/lute/AboutTab.html"
                  target="_blank"
                  rel="noopener"
                  class="text-blue-600 hover:underline"
                >
                  Full documentation
                </a>
              </p>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.help-panel-enter-active,
.help-panel-leave-active {
  transition: opacity 0.2s ease;
}

.help-panel-enter-active > div:last-child,
.help-panel-leave-active > div:last-child {
  transition: transform 0.2s ease;
}

.help-panel-enter-from,
.help-panel-leave-to {
  opacity: 0;
}

.help-panel-enter-from > div:last-child,
.help-panel-leave-to > div:last-child {
  transform: translateX(100%);
}
</style>
