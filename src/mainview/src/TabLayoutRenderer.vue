<script setup lang="ts">
import { computed } from 'vue'
import type { LayoutResult } from '../../shared/rpc-types'
import { dviToPt, toRenderItem, buildFontMap } from '../../shared/layout-render'

interface Props {
  layout: LayoutResult | null
  zoomLevel: number
  containerWidth: number
}

const props = withDefaults(defineProps<Props>(), {
  layout: null,
  zoomLevel: 100,
  containerWidth: 500,
})

const fontMap = computed(() =>
  props.layout ? buildFontMap(props.layout) : new Map(),
)

// Display width in px: container minus 32px padding, scaled by zoom
const pageDisplayWidthPx = computed((): number => {
  return Math.round((props.containerWidth - 32) * (props.zoomLevel / 100))
})

// SVG viewBox dimensions and content-origin offsets in points (DVI → pt).
// The engine does NOT bake margins into primitive coordinates — content starts
// at (0, 0) in DVI space. Apply left_margin_dvi and top_margin_dvi via a
// content translate.
const pageViewBox = computed(() => {
  if (!props.layout) return { w: 0, h: 0, topMargin: 0, leftMargin: 0 }
  return {
    w: dviToPt(props.layout.page_width_dvi),
    h: dviToPt(props.layout.page_height_dvi),
    topMargin: dviToPt(props.layout.top_margin_dvi),
    leftMargin: dviToPt(props.layout.left_margin_dvi),
  }
})

// Pre-computed pages → systems → render items, ready for the template
const renderedPages = computed(() => {
  if (!props.layout) return []
  const fonts = fontMap.value
  return props.layout.pages.map(page => ({
    page_num: page.page_num,
    systems: page.systems.map(system => ({
      system_num: system.system_num,
      items: system.primitives.map(p => toRenderItem(p, fonts)),
    })),
  }))
})
</script>

<template>
  <div v-if="layout" class="tab-layout-renderer">
    <div
      v-for="page in renderedPages"
      :key="page.page_num"
      class="tab-page"
    >
      <svg
        :viewBox="`0 0 ${pageViewBox.w} ${pageViewBox.h}`"
        :style="{ width: pageDisplayWidthPx + 'px', height: 'auto', display: 'block' }"
        xmlns="http://www.w3.org/2000/svg"
      >
        <!-- Content y=0 in DVI space corresponds to the top margin position.
             Translate down by top_margin_pt so content sits correctly on the page. -->
        <g :transform="`translate(${pageViewBox.leftMargin}, ${pageViewBox.topMargin})`">
        <g v-for="system in page.systems" :key="system.system_num">
          <template v-for="(item, idx) in system.items" :key="idx">

            <text
              v-if="item.kind === 'glyph'"
              :x="item.x"
              :y="item.y"
              :font-family="item.fontFamily"
              :font-size="item.fontSize"
              fill="black"
              dominant-baseline="auto"
            >{{ item.char }}</text>

            <text
              v-else-if="item.kind === 'text_run'"
              :x="item.x"
              :y="item.y"
              :font-family="item.fontFamily"
              :font-size="item.fontSize"
              fill="black"
              dominant-baseline="auto"
            >{{ item.text }}</text>

            <rect
              v-else-if="item.kind === 'rule'"
              :x="item.x"
              :y="item.y"
              :width="item.width"
              :height="item.height"
              fill="black"
            />

            <path
              v-else-if="item.kind === 'path'"
              :d="item.d"
              fill="none"
              stroke="black"
              stroke-width="0.5"
            />

            <path
              v-else-if="item.kind === 'filled-path'"
              :d="item.d"
              fill="black"
              stroke="none"
            />

            <line
              v-else-if="item.kind === 'line'"
              :x1="item.x1"
              :y1="item.y1"
              :x2="item.x2"
              :y2="item.y2"
              stroke="black"
              :stroke-width="item.strokeWidth"
            />

            <template v-else-if="item.kind === 'slash'">
              <rect
                v-for="(bar, bi) in item.rects"
                :key="bi"
                :x="bar.x"
                :y="bar.y"
                :width="bar.width"
                :height="bar.height"
                fill="black"
              />
            </template>

          </template>
        </g>
        </g>
      </svg>
    </div>
  </div>
</template>

<style scoped>
.tab-layout-renderer {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 16px;
}

.tab-page {
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
  background: white;
}
</style>
