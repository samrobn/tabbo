<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import TabLayoutRenderer from '../TabLayoutRenderer.vue'
import { COMPILE_MESSAGES } from '../constants'
import type { LayoutResult } from '../../../shared/rpc-types'
import { stepZoom, pageDisplayWidthPx, type ZoomState } from '../../../shared/zoom'
import { dviToPt } from '../../../shared/layout-render'
import {
  scrollFraction,
  scrollTopForFraction,
  clampScrollTop,
  buildLineOffsetMap,
  type LineOffsetPoint,
  type ScrollPosition,
} from '../../../shared/scroll-sync'

interface Props {
  layout: LayoutResult | null
  isLoading: boolean
  scrollSync: boolean
}

const props = withDefaults(defineProps<Props>(), {
  layout: null,
  isLoading: false,
  scrollSync: true,
})

const emit = defineEmits<{
  'update:scrollSync': [value: boolean]
  'scroll-position': [position: ScrollPosition]
}>()

// Container ref for measuring width, passed down to the renderer
const containerRef = ref<HTMLElement | null>(null)
const containerWidth = ref(500)

// Zoom state is a plain percentage, panel-relative and sticky: it means
// "rendered page width as a fraction of the panel's fit width" and keeps
// meaning that as the panel resizes (see src/shared/zoom.ts). 100 = fit.
const ZOOM_DEFAULT = 100
const ZOOM_MIN = 50
const ZOOM_MAX = 200
const ZOOM_STEP = 25
const zoomLevel = ref<ZoomState>(ZOOM_DEFAULT)

const canZoomOut = computed(() => zoomLevel.value > ZOOM_MIN)
const canZoomIn = computed(() => zoomLevel.value < ZOOM_MAX)

// Scroll sync: only the hovered pane emits scroll-position (loop prevention -
// a programmatic setScrollPosition write on the unhovered follower never
// re-emits). App.vue owns the enabled/disabled state and the other pane's ref.
const isHovered = ref<boolean>(false)

// Builds the line<->offset map from the current layout's anchors and the
// live-rendered `.tab-page` DOM positions. Measured at event time (scroll /
// incoming setScrollPosition) rather than cached in a computed - re-measuring
// tens of pages is cheap, and it sidesteps having to invalidate a cache on
// every layout/zoom/resize change.
function buildPreviewLineOffsetMap() {
  const layout = props.layout
  const container = containerRef.value
  if (!layout || !container || !layout.anchors || layout.anchors.length === 0) return null

  const pageWidthPt = dviToPt(layout.page_width_dvi)
  if (pageWidthPt <= 0) return null
  const pxPerPt = pageDisplayWidthPx(zoomLevel.value, containerWidth.value) / pageWidthPt

  const pageEls = container.querySelectorAll<HTMLElement>('.tab-page')
  if (pageEls.length === 0) return null
  const containerRect = container.getBoundingClientRect()

  const points: LineOffsetPoint[] = []
  for (const anchor of layout.anchors) {
    const pageEl = pageEls[anchor.page - 1]
    if (!pageEl) continue
    // Position of the page within the scrollable content, independent of the
    // current scroll offset: scrollTop + (page's viewport top - container's
    // viewport top).
    const pageOffset = container.scrollTop + (pageEl.getBoundingClientRect().top - containerRect.top)
    points.push({ line: anchor.line, offset: pageOffset + dviToPt(anchor.y) * pxPerPt })
  }
  return buildLineOffsetMap(points)
}

function onContainerScroll(): void {
  if (!isHovered.value) return
  const container = containerRef.value
  if (!container) return
  const map = buildPreviewLineOffsetMap()
  emit('scroll-position', {
    line: map ? map.offsetToLine(container.scrollTop) : null,
    fraction: scrollFraction(container.scrollTop, container.scrollHeight, container.clientHeight),
  })
}

function setScrollPosition(position: ScrollPosition): void {
  const container = containerRef.value
  if (!container) return
  const map = position.line !== null ? buildPreviewLineOffsetMap() : null
  const target = map && position.line !== null
    ? map.lineToOffset(position.line)
    : scrollTopForFraction(position.fraction, container.scrollHeight, container.clientHeight)
  container.scrollTop = clampScrollTop(target, container.scrollHeight, container.clientHeight)
}

defineExpose({ setScrollPosition })

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
  zoomLevel.value = stepZoom(zoomLevel.value, 1, ZOOM_STEP, ZOOM_MIN, ZOOM_MAX)
}

function zoomOut() {
  zoomLevel.value = stepZoom(zoomLevel.value, -1, ZOOM_STEP, ZOOM_MIN, ZOOM_MAX)
}

function resetZoom() {
  zoomLevel.value = ZOOM_DEFAULT
}
</script>

<template>
  <!-- `group` + `relative` make the floating zoom cluster below a CSS-only
       hover/focus reveal over the content area (no JS visibility listeners). -->
  <div class="relative h-full group">
    <div
      ref="containerRef"
      class="h-full p-4 overflow-auto"
      @scroll="onContainerScroll"
      @mouseenter="isHovered = true"
      @mouseleave="isHovered = false"
    >
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

    <!-- Floating zoom controls: top-right overlay, styled after the editor's
         .tab-search chip (white/bordered/rounded/shadowed). Hidden until the pane
         is hovered or a control inside it has focus - opacity/pointer-events only,
         no visibility JS. Right-anchored with the % label leftmost and a fixed
         min-width, so label-width changes extend leftward and the +/- buttons
         never move. -->
    <div
      v-if="layout"
      class="absolute top-4 right-6 z-20 flex items-center gap-0.5 px-1 py-0.5 bg-white border border-gray-300 rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.12)] text-xs transition-opacity opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto"
    >
      <button
        @click="emit('update:scrollSync', !scrollSync)"
        :aria-pressed="scrollSync"
        class="p-1 rounded transition-colors text-gray-600 hover:bg-gray-100"
        aria-label="Sync scrolling"
        title="Sync scrolling"
      >
        <!-- Paired up-down arrows: both panes scroll together. When sync is
             off the second arrow fades — the panes no longer move as one. -->
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 4v16m0-16L3 7m3-3l3 3M6 20l-3-3m3 3l3-3" />
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" :class="scrollSync ? '' : 'opacity-30'" d="M18 4v16m0-16l-3 3m3-3l3 3M18 20l-3-3m3 3l3-3" />
        </svg>
      </button>
      <!-- Divider between the sync toggle and the zoom cluster. -->
      <div class="w-px h-3 bg-gray-300 mx-0.5"></div>
      <!-- The label always shows the current zoom % and is itself the
           reset-to-100% control. -->
      <button
        @click="resetZoom"
        class="min-w-[2.75rem] text-right px-1 text-gray-600 hover:bg-gray-100 rounded tabular-nums"
        aria-label="Reset to 100%"
        title="Reset to 100%"
      >
        {{ zoomLevel }}%
      </button>
      <button
        @click="zoomOut"
        :disabled="!canZoomOut"
        :class="[
          'p-1 rounded transition-colors',
          !canZoomOut ? 'text-gray-300 cursor-not-allowed' : 'text-gray-600 hover:bg-gray-100'
        ]"
        aria-label="Zoom out"
        title="Zoom out"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 12H4" />
        </svg>
      </button>
      <button
        @click="zoomIn"
        :disabled="!canZoomIn"
        :class="[
          'p-1 rounded transition-colors',
          !canZoomIn ? 'text-gray-300 cursor-not-allowed' : 'text-gray-600 hover:bg-gray-100'
        ]"
        aria-label="Zoom in"
        title="Zoom in"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
        </svg>
      </button>
    </div>
  </div>
</template>
