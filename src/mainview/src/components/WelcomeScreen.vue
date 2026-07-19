<script setup lang="ts">
defineEmits<{ new: []; open: []; template: [] }>()
</script>

<template>
  <div class="flex-1 flex flex-col items-center justify-center gap-9 bg-app text-ink select-none">
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
        class="px-4 py-2 text-sm font-semibold bg-accent text-on-accent hover:bg-accent-soft rounded transition-colors"
      >New file</button>
      <button
        @click="$emit('open')"
        class="px-4 py-2 text-sm font-medium border border-hairline text-ink hover:bg-raise rounded transition-colors"
      >Open…</button>
      <button
        @click="$emit('template')"
        class="px-4 py-2 text-sm font-medium border border-hairline text-ink hover:bg-raise rounded transition-colors"
      >New from template</button>
    </div>
  </div>
</template>
