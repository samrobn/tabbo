<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import TabLayoutRenderer from '../TabLayoutRenderer.vue'
import { COMPILE_MESSAGES } from '../constants'
import type { LayoutResult } from '../../../shared/rpc-types'

interface Props {
  layout: LayoutResult | null
  isLoading: boolean
}

withDefaults(defineProps<Props>(), {
  layout: null,
  isLoading: false,
})

// Container ref for measuring width, passed down to the renderer
const containerRef = ref<HTMLElement | null>(null)
const containerWidth = ref(500)

// Zoom state — 100% = fit container width
const zoomLevel = ref(100)
const ZOOM_MIN = 50
const ZOOM_MAX = 200
const ZOOM_STEP = 25

function updateContainerWidth() {
  if (containerRef.value) {
    containerWidth.value = containerRef.value.clientWidth
  }
}

// Observe the container itself, not just window resize - the split divider changes
// the pane width without a window resize, and ResizeObserver catches both.
let resizeObserver: ResizeObserver | null = null
onMounted(() => {
  updateContainerWidth()
  if (containerRef.value) {
    resizeObserver = new ResizeObserver(updateContainerWidth)
    resizeObserver.observe(containerRef.value)
  }
})

onUnmounted(() => {
  resizeObserver?.disconnect()
})

function zoomIn() {
  zoomLevel.value = Math.min(zoomLevel.value + ZOOM_STEP, ZOOM_MAX)
}

function zoomOut() {
  zoomLevel.value = Math.max(zoomLevel.value - ZOOM_STEP, ZOOM_MIN)
}

function resetZoom() {
  zoomLevel.value = 100
}
</script>

<template>
  <div class="h-full flex flex-col">
    <!-- Header bar with zoom controls (title removed; matches the editor bar height for column alignment) -->
    <div class="px-3 h-11 bg-gray-50 border-b border-gray-200 flex items-center justify-end gap-2">
      <!-- Zoom controls (only shown when a layout is available) -->
      <div v-if="layout" class="flex items-center gap-1">
        <button
          @click="zoomOut"
          :disabled="zoomLevel <= ZOOM_MIN"
          :class="[
            'p-1 rounded transition-colors',
            zoomLevel <= ZOOM_MIN ? 'text-gray-300 cursor-not-allowed' : 'text-gray-600 hover:bg-gray-200'
          ]"
          title="Zoom out"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 12H4" />
          </svg>
        </button>
        <button
          @click="resetZoom"
          class="text-xs text-gray-600 hover:bg-gray-200 px-2 py-0.5 rounded min-w-[3rem]"
          title="Reset zoom"
        >
          {{ zoomLevel }}%
        </button>
        <button
          @click="zoomIn"
          :disabled="zoomLevel >= ZOOM_MAX"
          :class="[
            'p-1 rounded transition-colors',
            zoomLevel >= ZOOM_MAX ? 'text-gray-300 cursor-not-allowed' : 'text-gray-600 hover:bg-gray-200'
          ]"
          title="Zoom in"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Content area -->
    <div ref="containerRef" class="flex-1 p-4 overflow-auto">
      <!-- Spinner: only when loading with no prior layout (first compile / empty state) -->
      <div v-if="isLoading && !layout" class="flex flex-col items-center justify-center h-full gap-4">
        <svg class="animate-spin h-12 w-12 text-blue-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        <div class="text-gray-600 font-medium">{{ COMPILE_MESSAGES.COMPILING }}</div>
      </div>
      <!-- Renderer: independent v-if so it stays mounted during recompiles -->
      <TabLayoutRenderer
        v-if="layout"
        :layout="layout"
        :zoom-level="zoomLevel"
        :container-width="containerWidth"
      />
      <!-- Empty placeholder: no layout and not loading -->
      <div v-if="!layout && !isLoading" class="flex items-center justify-center h-full text-gray-400">
        {{ COMPILE_MESSAGES.EMPTY_PREVIEW }}
      </div>
    </div>
  </div>
</template>
