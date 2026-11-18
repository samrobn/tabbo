<script setup lang="ts">
import { computed } from 'vue'
import { basename, dirname, tildify } from '../../../shared/display-path'

const props = withDefaults(defineProps<{ recentFiles?: string[] }>(), { recentFiles: () => [] })
defineEmits<{ new: []; open: []; template: []; openRecent: [path: string] }>()

const RECENT_SHOWN = 5
const recents = computed(() =>
  props.recentFiles.slice(0, RECENT_SHOWN).map((path) => ({ path, name: basename(path), folder: tildify(dirname(path)) })),
)
</script>

<template>
  <div class="fade-in flex-1 flex flex-col items-center justify-center gap-9 bg-app text-ink select-none">
    <svg class="w-[346px] h-auto" viewBox="-2 -2 918 338" role="img" aria-label="Tabbo" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="72" height="34" rx="17" fill="#4a4d55"/>
      <rect x="84" y="0" width="84" height="34" rx="17" fill="#e0906a"/>
      <rect x="180" y="0" width="44" height="34" rx="17" fill="#e0906a"/>
      <rect x="68" y="60" width="58" height="34" rx="17" fill="#4a4d55"/>
      <rect x="68" y="120" width="58" height="34" rx="17" fill="#4a4d55"/>
      <rect x="68" y="180" width="58" height="34" rx="17" fill="#4a4d55"/>
      <rect x="68" y="240" width="58" height="34" rx="17" fill="#4a4d55"/>
      <rect x="68" y="300" width="58" height="34" rx="17" fill="#4a4d55"/>
      <rect x="206" y="180" width="44" height="34" rx="17" fill="#4a4d55"/>
      <rect x="262" y="180" width="52" height="34" rx="17" fill="#4a4d55"/>
      <rect x="150" y="240" width="100" height="34" rx="17" fill="#4a4d55"/>
      <rect x="262" y="240" width="52" height="34" rx="17" fill="#4a4d55"/>
      <rect x="158" y="300" width="84" height="34" rx="17" fill="#4a4d55"/>
      <rect x="254" y="300" width="60" height="34" rx="17" fill="#4a4d55"/>
      <rect x="338" y="60" width="58" height="34" rx="17" fill="#7fb8a4"/>
      <rect x="338" y="120" width="58" height="34" rx="17" fill="#9d8cc9"/>
      <rect x="338" y="180" width="92" height="34" rx="17" fill="#eeb45e"/>
      <rect x="442" y="180" width="40" height="34" rx="17" fill="#e6e4de"/>
      <rect x="338" y="240" width="100" height="34" rx="17" fill="#9d8cc9"/>
      <rect x="450" y="240" width="64" height="34" rx="17" fill="#7fb8a4"/>
      <rect x="338" y="300" width="68" height="34" rx="17" fill="#e6e4de"/>
      <rect x="418" y="300" width="48" height="34" rx="17" fill="#9d8cc9"/>
      <rect x="538" y="60" width="58" height="34" rx="17" fill="#7fb8a4"/>
      <rect x="538" y="120" width="58" height="34" rx="17" fill="#9d8cc9"/>
      <rect x="538" y="180" width="92" height="34" rx="17" fill="#eeb45e"/>
      <rect x="642" y="180" width="40" height="34" rx="17" fill="#e6e4de"/>
      <rect x="538" y="240" width="100" height="34" rx="17" fill="#9d8cc9"/>
      <rect x="650" y="240" width="64" height="34" rx="17" fill="#7fb8a4"/>
      <rect x="538" y="300" width="68" height="34" rx="17" fill="#e6e4de"/>
      <rect x="618" y="300" width="48" height="34" rx="17" fill="#9d8cc9"/>
      <rect x="754" y="180" width="92" height="34" rx="17" fill="#4a4d55"/>
      <rect x="858" y="180" width="40" height="34" rx="17" fill="#4a4d55"/>
      <rect x="738" y="240" width="100" height="34" rx="17" fill="#4a4d55"/>
      <rect x="850" y="240" width="64" height="34" rx="17" fill="#4a4d55"/>
      <rect x="762" y="300" width="68" height="34" rx="17" fill="#4a4d55"/>
      <rect x="842" y="300" width="48" height="34" rx="17" fill="#4a4d55"/>
    </svg>
    <div class="flex flex-col gap-2 w-56">
      <button
        @click="$emit('new')"
        class="btn btn-primary px-4 py-2"
      >New file</button>
      <button
        @click="$emit('open')"
        class="btn btn-secondary px-4 py-2 text-ink"
      >Open…</button>
      <button
        @click="$emit('template')"
        class="btn btn-secondary px-4 py-2 text-ink"
      >New from template</button>
    </div>
    <section v-if="recents.length" class="flex flex-col gap-1 w-72" aria-labelledby="welcome-recent">
      <h2 id="welcome-recent" class="eyebrow px-2">Recent</h2>
      <button
        v-for="recent in recents"
        :key="recent.path"
        :title="recent.path"
        @click="$emit('openRecent', recent.path)"
        class="flex flex-col items-start px-2 py-1 rounded-control text-left hover:bg-hairline transition-colors"
      >
        <span class="text-sm text-ink truncate max-w-full">{{ recent.name }}</span>
        <span class="text-xs text-ink-soft truncate max-w-full">{{ recent.folder }}</span>
      </button>
    </section>
  </div>
</template>
