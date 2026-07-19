<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { UpdateStatus } from '../../../shared/rpc-types'

const props = defineProps<{
  status: UpdateStatus | null
  /**
   * Version string to display. Tracked by App.vue across phase transitions
   * because the `ready` phase carries no version field.
   */
  trackedVersion: string | null
  changelog: string | null
  /** True while applyDownloadedUpdate RPC is in-flight; disables the Restart button. */
  isApplying: boolean
}>()

const emit = defineEmits<{
  /** User clicked "Install now" on the available phase. */
  download: []
  /** User clicked "Remind me later" — caller persists the snoozed version. */
  snooze: []
  /** User clicked "Restart now" on the ready phase. */
  apply: []
  /** User dismissed the error state. */
  dismissError: []
}>()

// Focus the modal root whenever it becomes visible so `@keydown.esc` actually
// fires. Without this, focus stays on the editor and Esc never bubbles to the
// modal element. `tabindex="-1"` on the root makes it programmatically focusable
// without putting it in the tab order.
const modalRoot = ref<HTMLDivElement | null>(null)
const isVisible = (phase: UpdateStatus['phase'] | undefined): boolean =>
  phase !== undefined && phase !== 'idle' && phase !== 'checking'
watch(
  () => props.status?.phase,
  (phase, prevPhase) => {
    if (isVisible(phase) && !isVisible(prevPhase)) {
      nextTick(() => modalRoot.value?.focus())
    }
  },
  { immediate: true },
)
</script>

<template>
  <Teleport to="body">
    <div
      v-if="status && status.phase !== 'idle' && status.phase !== 'checking'"
      ref="modalRoot"
      tabindex="-1"
      class="fixed inset-0 z-50 flex items-center justify-center outline-none"
      @keydown.esc="
        status.phase === 'available' ? emit('snooze')
        : status.phase === 'error' ? emit('dismissError')
        : undefined
      "
    >
      <!-- Backdrop — only dismissible on available / error states -->
      <div
        class="absolute inset-0 bg-black/40"
        @click="
          status.phase === 'available' ? emit('snooze')
          : status.phase === 'error' ? emit('dismissError')
          : undefined
        "
      />

      <div
        class="relative bg-raise border border-hairline text-ink rounded-lg shadow-xl p-6 max-w-md w-full mx-4"
        @click.stop
      >
        <!-- available -->
        <template v-if="status.phase === 'available'">
          <h2 class="text-base font-semibold text-ink mb-1">
            Update available
            <span v-if="trackedVersion" class="font-normal text-ink-soft">— v{{ trackedVersion }}</span>
          </h2>
          <p class="text-sm text-ink-soft mb-4">A new version of Tabbo is ready to download.</p>

          <template v-if="changelog">
            <p class="text-xs font-medium text-ink-soft uppercase tracking-wide mb-1">What's new</p>
            <pre class="whitespace-pre-wrap text-sm font-mono bg-head text-ink border border-hairline rounded p-3 mb-5 max-h-48 overflow-y-auto">{{ changelog }}</pre>
          </template>

          <div class="flex justify-end gap-3">
            <button
              @click="emit('snooze')"
              class="px-3 py-1.5 text-sm font-medium border border-hairline text-ink-soft hover:bg-hairline rounded transition-colors"
            >
              Remind me later
            </button>
            <button
              @click="emit('download')"
              class="px-3 py-1.5 text-sm font-semibold text-on-accent bg-accent hover:bg-accent-soft rounded transition-colors"
            >
              Install now
            </button>
          </div>
        </template>

        <!-- downloading -->
        <template v-else-if="status.phase === 'downloading'">
          <h2 class="text-base font-semibold text-ink mb-1">Downloading update…</h2>
          <p class="text-sm text-ink-soft mb-4">
            <template v-if="trackedVersion">Downloading v{{ trackedVersion }}.</template>
            <template v-else>Download in progress.</template>
            Please keep Tabbo open.
          </p>
          <div class="w-full bg-head rounded-full h-2 mb-5">
            <div
              class="bg-accent h-2 rounded-full transition-all duration-300"
              :style="{
                width: status.progress != null ? `${Math.round(status.progress)}%` : '100%',
              }"
              :class="{ 'animate-pulse': status.progress == null }"
            />
          </div>
          <p class="text-xs text-ink-soft text-right">
            {{ status.progress != null ? `${Math.round(status.progress)}%` : 'Preparing…' }}
          </p>
        </template>

        <!-- ready -->
        <template v-else-if="status.phase === 'ready'">
          <h2 class="text-base font-semibold text-ink mb-1">
            Update ready
            <span v-if="trackedVersion" class="font-normal text-ink-soft">— v{{ trackedVersion }}</span>
          </h2>
          <p class="text-sm text-ink-soft mb-5">
            The update has been downloaded. Tabbo will restart to apply it.
          </p>
          <div class="flex justify-end">
            <button
              @click="emit('apply')"
              :disabled="isApplying"
              class="px-3 py-1.5 text-sm font-semibold text-on-accent bg-accent rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              :class="{ 'hover:bg-accent-soft': !isApplying }"
            >
              {{ isApplying ? 'Restarting Tabbo…' : 'Restart now' }}
            </button>
          </div>
        </template>

        <!-- error -->
        <template v-else-if="status.phase === 'error'">
          <h2 class="text-base font-semibold text-error-soft mb-1">Update failed</h2>
          <p class="text-sm text-ink-soft mb-5">{{ status.message }}</p>
          <div class="flex justify-end">
            <button
              @click="emit('dismissError')"
              class="px-3 py-1.5 text-sm font-medium border border-hairline text-ink-soft hover:bg-hairline rounded transition-colors"
            >
              Dismiss
            </button>
          </div>
        </template>
      </div>
    </div>
  </Teleport>
</template>
