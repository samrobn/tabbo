<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import Electrobun, { Electroview } from 'electrobun/view'
import TabCodeEditor from './components/TabCodeEditor.vue'
import TabPreview from './components/TabPreview.vue'
import HelpPanel from './components/HelpPanel.vue'
import UpdateModal from './components/UpdateModal.vue'
import { DEFAULT_TAB_CONTENT, COMPILE_MESSAGES, STORAGE_KEYS, AUTO_SAVE_INTERVAL_MS } from './constants'
import { examples } from './examples'
import type { TabboRPC, LayoutResult, Settings, CompilationError, UpdateStatus, SaveResult } from '../../shared/rpc-types'
import { startCaptureWorker } from './composables/useCaptureWorker'

// CSS px per pt at the canonical 96 DPI reference pixel density (1pt = 1/72 in, 1px = 1/96 in)
const PT_TO_PX = 96 / 72

const basename = (path: string) => path.split("/").pop() ?? path

function capturePreviewPages(): Array<{ svg: string; widthPx: number; heightPx: number }> {
  if (!layoutResult.value) return []

  const svgEls = document.querySelectorAll<SVGSVGElement>('.tab-layout-renderer svg')
  if (svgEls.length === 0) return []

  const serialiser = new XMLSerializer()
  const pages: Array<{ svg: string; widthPx: number; heightPx: number }> = []

  svgEls.forEach(svgEl => {
    // Derive canonical pixel dimensions from the viewBox (which is in points).
    // viewBox is "0 0 page_width_pt page_height_pt" - vb.width/height are the full page dimensions.
    const vb = svgEl.viewBox.baseVal
    const widthPx  = Math.round(vb.width  * PT_TO_PX)
    const heightPx = Math.round(vb.height * PT_TO_PX)

    // Clone so we can set explicit width/height attributes without mutating the live DOM.
    const clone = svgEl.cloneNode(true) as SVGSVGElement
    clone.setAttribute('width',  String(widthPx))
    clone.setAttribute('height', String(heightPx))
    // Remove the CSS style width (zoom-scaled display value) so the embedded SVG
    // is self-contained at its canonical size.
    clone.style.removeProperty('width')
    clone.style.removeProperty('height')
    // Ensure standalone xmlns declaration survives serialisation.
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')

    pages.push({ svg: serialiser.serializeToString(clone), widthPx, heightPx })
  })

  return pages
}

const rpc = Electroview.defineRPC<TabboRPC>({
  maxRequestTime: 15_000,
  handlers: {
    messages: {
      menuAction: ({ action }) => {
        switch (action) {
          case 'open': openFile(); break
          case 'save': saveFile(); break
          case 'exportPdf': exportPdf(); break
          case 'new': clearDraft(); break
          case 'showHelp': showHelpPanel.value = true; break
          case 'quitRequested': handleWindowAction('quit'); break
          case 'closeRequested': handleWindowAction('close'); break
        }
      },
      updateStatusChanged: ({ status }) => {
        handleUpdateStatus(status)
      },
    },
  },
})

const electrobun = new Electrobun.Electroview({ rpc })

const tabContent = ref<string>(DEFAULT_TAB_CONTENT)
const layoutResult = ref<LayoutResult | null>(null)
const isCompiling = ref<boolean>(false)
const errors = ref<CompilationError[]>([])
const activeTab = ref<'editor' | 'preview'>('editor')
// Reduced from 1500ms: getLayout resolves in milliseconds via the long-lived worker
const compileDebounceMs = 100
const currentFilename = ref<string>('untitled.tab')
const currentFilePath = ref<string | null>(null)
const isDirty = ref<boolean>(false)
const showExamplesDropdown = ref<boolean>(false)
const showHelpPanel = ref<boolean>(false)
const fontSize = ref<number>(14)
const exportStatus = ref<{ success: boolean; message: string } | null>(null)
const confirmModalOpen = ref<boolean>(false)
const confirmModalMessage = ref<string>('')
const confirmPrimaryLabel = ref<string>('Discard changes')
let confirmResolver: ((value: boolean) => void) | null = null
const confirmPrimaryBtn = ref<HTMLButtonElement | null>(null)

// Three-way quit modal - separate from the binary askConfirm so its six existing
// callers are untouched. Resolves to 'save' | 'discard' | 'cancel'.
const quitModalOpen = ref<boolean>(false)
let quitResolver: ((value: 'save' | 'discard' | 'cancel') => void) | null = null
const quitSaveBtn = ref<HTMLButtonElement | null>(null)

// Update state - version is tracked across phases because `ready` carries no version field
const updateStatus = ref<UpdateStatus | null>(null)
const updateTrackedVersion = ref<string | null>(null)
const updateChangelog = ref<string | null>(null)
const isApplyingUpdate = ref<boolean>(false)

let debounceTimer: ReturnType<typeof setTimeout> | null = null
let autoSaveTimer: ReturnType<typeof setInterval> | null = null
let exportStatusTimer: ReturnType<typeof setTimeout> | null = null
let stopCaptureWorker: (() => void) | null = null
let skipNextCompile = false
let skipNextDirtyMark = false
let windowActionInFlight = false
let currentCompileId = 0

const errorLines = computed(() =>
  errors.value
    .filter(e => e.line !== undefined)
    .map(e => e.line as number)
)

// Update window title when filename or dirty state changes
watch([currentFilename, isDirty], () => {
  const dirty = isDirty.value ? ' - Edited' : ''
  const title = `${currentFilename.value}${dirty} - Tabbo`
  electrobun.rpc?.send.titleChanged({ title })
})

async function getLayout(): Promise<void> {
  const compileId = ++currentCompileId
  isCompiling.value = true
  errors.value = []

  try {
    const response = await electrobun.rpc!.request.getLayout({
      content: tabContent.value,
    })

    // Superseded: a newer request overtook this one - discard silently
    if (response.superseded === true) return

    if (compileId !== currentCompileId) return

    if (response.layout) {
      layoutResult.value = response.layout
      errors.value = response.errors.length > 0 ? response.errors : []
      if (window.innerWidth < 768) {
        activeTab.value = 'preview'
      }
    } else {
      errors.value = response.errors.length > 0
        ? response.errors
        : [{ message: COMPILE_MESSAGES.COMPILATION_FAILED }]
      layoutResult.value = null
    }
  } catch (error) {
    if (compileId !== currentCompileId) return
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    errors.value = [{ message: `Compilation error: ${errorMessage}` }]
    layoutResult.value = null
  } finally {
    if (compileId === currentCompileId) {
      isCompiling.value = false
    }
  }
}

function handleKeyboardShortcut(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key === 's') {
    event.preventDefault()
    saveFile()
  }
}

function debouncedCompile(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
  }

  debounceTimer = setTimeout(() => {
    getLayout()
    debounceTimer = null
  }, compileDebounceMs)
}

function askConfirm(message: string, primaryLabel = "Discard changes"): Promise<boolean> {
  if (confirmResolver) {
    confirmResolver(false)
    confirmResolver = null
  }
  return new Promise(resolve => {
    confirmModalMessage.value = message
    confirmPrimaryLabel.value = primaryLabel
    confirmModalOpen.value = true
    confirmResolver = resolve
    nextTick(() => confirmPrimaryBtn.value?.focus())
  })
}

function resolveConfirm(value: boolean): void {
  confirmModalOpen.value = false
  const resolve = confirmResolver
  confirmResolver = null
  resolve?.(value)
}

// Update lifecycle handlers

/**
 * Receive a pushed UpdateStatus from the bun side. On `available`, capture
 * version + changelog so they persist into `downloading` and `ready` phases
 * where the status object itself no longer carries them.
 */
function handleUpdateStatus(status: UpdateStatus): void {
  if (status.phase === 'available') {
    const snoozed = localStorage.getItem(STORAGE_KEYS.UPDATE_SNOOZED_VERSION)
    // Only suppress when we have a concrete version to compare - null version
    // (Electrobun pushed event before version is known) must not collide with
    // null from getItem on a fresh install.
    if (status.version != null && snoozed === status.version) {
      // User already dismissed this version - stay idle
      return
    }
    updateTrackedVersion.value = status.version
    updateChangelog.value = status.changelog
  }
  if (status.phase === 'error') {
    // Apply (or download) failed mid-flight: release the apply lock so the
    // user can retry from the available phase once they've dismissed.
    // Without this, the Restart button stays disabled forever after an
    // apply failure that surfaces as an error event rather than as an
    // exception thrown from the RPC call.
    isApplyingUpdate.value = false
  }
  updateStatus.value = status
}

function snoozeUpdate(): void {
  // Only persist when we have a real version - writing '' or null would poison
  // the snooze state and trigger the null === null false-positive on next launch.
  if (updateTrackedVersion.value != null) {
    try {
      localStorage.setItem(STORAGE_KEYS.UPDATE_SNOOZED_VERSION, updateTrackedVersion.value)
    } catch {
      // localStorage may be unavailable
    }
  }
  updateStatus.value = null
}

async function startDownload(): Promise<void> {
  try {
    await electrobun.rpc!.request.startUpdateDownload({})
    // Progress arrives via updateStatusChanged messages; nothing to do here
  } catch (error) {
    console.error('Failed to start update download:', error)
  }
}

async function applyUpdate(): Promise<void> {
  if (isApplyingUpdate.value) return
  isApplyingUpdate.value = true
  try {
    await electrobun.rpc!.request.applyDownloadedUpdate({})
    // App will relaunch; if somehow we return, leave isApplyingUpdate true
    // so the button stays disabled while the OS processes the relaunch.
  } catch (error) {
    console.error('Failed to apply update:', error)
    isApplyingUpdate.value = false
  }
}

function dismissUpdateError(): void {
  updateStatus.value = null
}

// File operations via native RPC
async function openFile(): Promise<void> {
  if (isDirty.value && !(await askConfirm('You have unsaved changes. Open another file and discard them?'))) {
    return
  }
  try {
    const result = await electrobun.rpc!.request.openFile({})
    if (!result) return

    skipNextCompile = true
    skipNextDirtyMark = true
    layoutResult.value = null
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null }
    tabContent.value = result.content
    currentFilename.value = result.filename
    currentFilePath.value = result.path
    isDirty.value = false
    saveToLocalStorage()
    getLayout()

    await electrobun.rpc!.request.updateSettings({
      lastOpenedFile: result.path,
    })
  } catch (error) {
    console.error('Failed to open file:', error)
  }
}

async function saveFile(opts: { skipCopyConfirm?: boolean } = {}): Promise<boolean> {
  try {
    // A save that creates a NEW file (no tracked path yet, or the filename was
    // changed away from the open file's name) writes a copy - confirm first so it
    // is never a surprise. A plain round-trip save (same name, known path) is silent.
    // skipCopyConfirm suppresses this for the quit path where Save intent is already given.
    const targetIsNewFile =
      !currentFilePath.value ||
      basename(currentFilePath.value) !== currentFilename.value
    if (targetIsNewFile && !opts.skipCopyConfirm) {
      const ok = await askConfirm(`Save a copy named "${currentFilename.value}"?`, 'Save copy')
      if (!ok) return false
    }

    const result = await electrobun.rpc!.request.saveFile({
      content: tabContent.value,
      filename: currentFilename.value,
      currentPath: currentFilePath.value,
    })
    return await applySaveResult(result, false)
  } catch (error) {
    console.error('Failed to save file:', error)
    showExportStatus(false, 'Save failed')
    return false
  }
}

async function applySaveResult(result: SaveResult, didConfirm: boolean): Promise<boolean> {
  if (result.ok) {
    currentFilePath.value = result.path
    currentFilename.value = basename(result.path) // pick up normalisation
    isDirty.value = false
    clearDraftStorage()
    try {
      await electrobun.rpc!.request.updateSettings({ lastOpenedFile: result.path })
    } catch {
      // Best-effort: a settings-write failure must not turn a successful save into
      // a reported failure or block the quit flow.
    }
    showExportStatus(true, `Saved to ${result.path}`)
    return true
  }
  if (result.reason === "needs-overwrite-confirm" && !didConfirm) {
    const ok = await askConfirm(`${basename(result.path)} already exists. Overwrite?`, "Overwrite")
    if (!ok) return false
    const retry = await electrobun.rpc!.request.saveFile({
      content: tabContent.value,
      filename: currentFilename.value,
      currentPath: currentFilePath.value,
      confirmOverwrite: true,
    })
    return await applySaveResult(retry, true)
  }
  if (result.reason === "error") showExportStatus(false, result.message)
  return false
}

function showExportStatus(success: boolean, message: string): void {
  exportStatus.value = { success, message }
  if (exportStatusTimer) clearTimeout(exportStatusTimer)
  exportStatusTimer = setTimeout(() => {
    exportStatus.value = null
    exportStatusTimer = null
  }, 4_000)
}

async function exportPdf(): Promise<void> {
  try {
    const result = await electrobun.rpc!.request.compileToPdf({
      content: tabContent.value,
      filename: currentFilename.value,
    })
    if (result.success) {
      showExportStatus(true, `Saved to ${result.path}`)
    } else {
      showExportStatus(false, result.message)
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error'
    console.error('Failed to export PDF:', error)
    showExportStatus(false, `Export failed: ${msg}`)
  }
}

// Remove all three draft keys - after this the draft slot is empty and a
// future autosave (which only writes when dirty) will not re-populate it.
function clearDraftStorage(): void {
  try {
    localStorage.removeItem(STORAGE_KEYS.DRAFT)
    localStorage.removeItem(STORAGE_KEYS.FILENAME)
    localStorage.removeItem(STORAGE_KEYS.FILEPATH)
  } catch {
    // localStorage may be unavailable
  }
}

// localStorage as crash-recovery backup - only written while the buffer is
// dirty. When clean, the draft is cleared so "a draft exists at launch" means
// "genuine unsaved work" by construction; a clean exit cannot leave a stray draft.
function saveToLocalStorage(): void {
  if (!isDirty.value) {
    clearDraftStorage()
    return
  }
  try {
    localStorage.setItem(STORAGE_KEYS.DRAFT, tabContent.value)
    localStorage.setItem(STORAGE_KEYS.FILENAME, currentFilename.value)
    localStorage.setItem(STORAGE_KEYS.FILEPATH, currentFilePath.value ?? "")
  } catch {
    // localStorage may be unavailable or full
  }
}

function onFilenameInput(value: string) {
  currentFilename.value = value;
  isDirty.value = true;        // a rename is an unsaved change (the tabContent watcher won't catch it)
  saveToLocalStorage();
}

// Reopen the last file from disk, or leave the default blank document as-is.
// `settings` is passed in from onMounted - do NOT call getSettings again here.
async function reopenLast(settings: Settings): Promise<void> {
  const lastPath = settings.lastOpenedFile
  if (!lastPath) return
  try {
    const file = await electrobun.rpc!.request.readFile({ path: lastPath })
    if (!file) return  // missing or unreadable
    skipNextCompile = true
    skipNextDirtyMark = true
    tabContent.value = file.content
    currentFilename.value = file.filename
    // Supply the path explicitly - readFile returns content+filename only.
    // Setting currentFilePath here is what makes the reopened file round-trip
    // on Save without falling back to a new copy in ~/Documents/Tabbo.
    currentFilePath.value = lastPath
    isDirty.value = false
  } catch {
    // File unreadable - leave the default blank document
  }
}

// On mount: if a draft exists (⇒ genuine unsaved work from an unclean exit), offer
// to restore it; otherwise reopen the last file from disk (or stay blank).
// `settings` is passed in from onMounted - do NOT call getSettings again here.
async function restoreSession(settings: Settings): Promise<void> {
  let draftContent: string | null = null
  try {
    draftContent = localStorage.getItem(STORAGE_KEYS.DRAFT)
  } catch {
    // localStorage may be unavailable
  }

  if (draftContent) {
    const restore = await askConfirm('Restore unsaved changes from your last session?', 'Restore')
    if (restore) {
      // Load the draft - mirrors what loadFromLocalStorage did.
      const savedFilename = localStorage.getItem(STORAGE_KEYS.FILENAME)
      const savedPath = localStorage.getItem(STORAGE_KEYS.FILEPATH) || ""
      skipNextCompile = true
      skipNextDirtyMark = true
      tabContent.value = draftContent
      if (savedFilename) {
        currentFilename.value = savedFilename
      }
      if (savedPath) {
        try {
          const exists = await electrobun.rpc!.request.fileExists({ path: savedPath })
          currentFilePath.value = exists ? savedPath : null
        } catch {
          currentFilePath.value = null
        }
      } else {
        currentFilePath.value = null
      }
      // A restored draft is unsaved work - mark dirty so the quit warning fires
      // and the autosave keeps the draft alive during the session.
      isDirty.value = true
    } else {
      clearDraftStorage()
      await reopenLast(settings)
    }
  } else {
    await reopenLast(settings)
  }
}

async function clearDraft(): Promise<void> {
  if (isDirty.value && !(await askConfirm('Discard unsaved changes?'))) {
    return
  }
  clearDraftStorage()
  // Clear lastOpenedFile so reopen-last never resurrects a file the user left for New.
  try {
    await electrobun.rpc!.request.updateSettings({ lastOpenedFile: null })
  } catch {
    // Settings update is best-effort; don't block the New action
  }
  skipNextDirtyMark = true
  layoutResult.value = null
  tabContent.value = DEFAULT_TAB_CONTENT
  currentFilename.value = 'untitled.tab'
  currentFilePath.value = null
  isDirty.value = false
}

function askQuitChoice(): Promise<'save' | 'discard' | 'cancel'> {
  if (quitResolver) {
    quitResolver('cancel')
    quitResolver = null
  }
  return new Promise(resolve => {
    quitModalOpen.value = true
    quitResolver = resolve
    nextTick(() => quitSaveBtn.value?.focus())
  })
}

function resolveQuit(choice: 'save' | 'discard' | 'cancel'): void {
  quitModalOpen.value = false
  const resolve = quitResolver
  quitResolver = null
  resolve?.(choice)
}

async function handleWindowAction(action: 'quit' | 'close'): Promise<void> {
  if (windowActionInFlight) return
  windowActionInFlight = true
  try {
    // Belt-and-braces: flush the draft before showing the modal so the latest
    // on-screen content is preserved even if the user then force-quits the process.
    if (isDirty.value) saveToLocalStorage()

    if (!isDirty.value) {
      electrobun.rpc!.send.windowActionResponse({ action, proceed: true })
      return
    }

    const choice = await askQuitChoice()

    if (choice === 'cancel') {
      electrobun.rpc!.send.windowActionResponse({ action, proceed: false })
      return
    }

    if (choice === 'save') {
      // skipCopyConfirm: Save intent already given in the quit modal; still
      // honours overwrite-confirm inside applySaveResult when a name collision occurs.
      const saved = await saveFile({ skipCopyConfirm: true })
      if (!saved) {
        // Cancelled at the overwrite prompt or the write errored - stay open.
        electrobun.rpc!.send.windowActionResponse({ action, proceed: false })
        return
      }
      // applySaveResult already set isDirty=false and cleared the draft.
    } else {
      // discard - clear dirty and draft so the teardown autosave writes nothing.
      isDirty.value = false
      clearDraftStorage()
    }

    electrobun.rpc!.send.windowActionResponse({ action, proceed: true })
  } finally {
    windowActionInFlight = false
  }
}

async function loadExample(exampleName: string): Promise<void> {
  if (isDirty.value && !(await askConfirm('Discard unsaved changes?'))) {
    return
  }
  const example = examples.find(e => e.name === exampleName)
  if (example) {
    layoutResult.value = null
    skipNextCompile = true
    skipNextDirtyMark = true
    tabContent.value = example.content
    currentFilename.value = `${exampleName.toLowerCase()}.tab`
    currentFilePath.value = null
    isDirty.value = false
    showExamplesDropdown.value = false
    saveToLocalStorage()

    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    getLayout()
  }
}

watch(tabContent, () => {
  if (skipNextDirtyMark) {
    skipNextDirtyMark = false
  } else {
    isDirty.value = true
  }

  if (skipNextCompile) {
    skipNextCompile = false
    return
  }
  debouncedCompile()
})

onMounted(async () => {
  window.addEventListener('keydown', handleKeyboardShortcut)

  // Load persisted settings - captured here and threaded into restoreSession
  // so getSettings is only called once.
  let settings: Settings = { fontSize: 14, theme: 'light' as const, lastOpenedFile: null }
  try {
    settings = await electrobun.rpc!.request.getSettings({})
    fontSize.value = settings.fontSize
  } catch {
    // Settings unavailable (e.g. HMR mode) - use defaults
  }

  try {
    await restoreSession(settings)
  } catch (error) {
    console.error('Session restore failed:', error)
  }
  autoSaveTimer = setInterval(saveToLocalStorage, AUTO_SAVE_INTERVAL_MS)
  window.addEventListener('blur', saveToLocalStorage)

  // Single initial compile for whatever was loaded by restoreSession.
  // The skipNextCompile guard on the content watcher prevents the watcher from
  // double-compiling, so this setTimeout is the only compile that fires on launch.
  setTimeout(() => getLayout(), 100)

  // Check for updates after a short delay so the initial layout RPC has settled.
  // Fires silently on dev channel (bun side returns available: false immediately).
  // webview→bun requests don't have the focus gate that affects bun→webview pushes,
  // so 500ms is sufficient - matching the getLayout delay above.
  setTimeout(async () => {
    try {
      const info = await electrobun.rpc!.request.checkForUpdate({})
      if (info.available) {
        handleUpdateStatus({
          phase: 'available',
          version: info.version,
          changelog: info.changelog,
        })
      }
    } catch {
      // Update check is best-effort; don't surface errors to the user
    }
  }, 500)

  stopCaptureWorker = startCaptureWorker({
    setLayout: (l) => { layoutResult.value = l },
    setFilename: (f) => { currentFilename.value = f },
    capturePreviewPages,
  })
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyboardShortcut)
  window.removeEventListener('blur', saveToLocalStorage)
  if (debounceTimer) clearTimeout(debounceTimer)
  if (autoSaveTimer) clearInterval(autoSaveTimer)
  if (exportStatusTimer) clearTimeout(exportStatusTimer)
  if (confirmResolver) { confirmResolver(false); confirmResolver = null }
  if (quitResolver) { quitResolver('cancel'); quitResolver = null }
  stopCaptureWorker?.()
  // Only writes if isDirty - a clean exit does not leave a stray draft.
  saveToLocalStorage()
})
</script>

<template>
  <div class="h-screen flex flex-col bg-gray-100">
    <header class="bg-white shadow-sm border-b border-gray-200">
      <div class="px-4 py-2 flex items-center justify-between gap-4">
        <div class="flex items-center gap-3">
          <h1 class="text-xl font-semibold text-gray-800">Tabbo</h1>
          <input
            class="filename-field"
            :value="currentFilename"
            @input="onFilenameInput(($event.target as HTMLInputElement).value)"
            @keydown.enter="($event.target as HTMLInputElement).blur()"
            spellcheck="false"
            aria-label="Document name"
          />
          <span v-if="isDirty" class="text-xs text-amber-600 font-medium">Edited</span>
        </div>

        <div class="flex items-center gap-2">
          <div class="relative">
            <button
              @click="showExamplesDropdown = !showExamplesDropdown"
              class="px-3 py-1.5 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded transition-colors flex items-center gap-1"
              title="Load example"
            >
              Examples
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            <div
              v-if="showExamplesDropdown"
              class="absolute top-full left-0 mt-1 w-48 bg-white border border-gray-200 rounded-md shadow-lg z-20"
            >
              <button
                v-for="example in examples"
                :key="example.name"
                @click="loadExample(example.name)"
                class="w-full px-3 py-2 text-left text-sm hover:bg-gray-100 first:rounded-t-md last:rounded-b-md"
              >
                <div class="font-medium text-gray-800">{{ example.name }}</div>
                <div class="text-xs text-gray-500">{{ example.description }}</div>
              </button>
            </div>
          </div>

          <button
            @click="showHelpPanel = true"
            class="px-3 py-1.5 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded transition-colors flex items-center gap-1"
            title="Syntax help"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Help
          </button>
        </div>
      </div>
    </header>

    <!-- Mobile tab navigation -->
    <div class="md:hidden bg-white border-b border-gray-200">
      <div class="flex">
        <button
          @click="activeTab = 'editor'"
          :class="[
            'flex-1 px-4 py-2 text-sm font-medium transition-colors',
            activeTab === 'editor'
              ? 'bg-blue-50 text-blue-700 border-b-2 border-blue-600'
              : 'text-gray-600 hover:text-gray-800'
          ]"
        >
          Editor
        </button>
        <button
          @click="activeTab = 'preview'"
          :class="[
            'flex-1 px-4 py-2 text-sm font-medium transition-colors',
            activeTab === 'preview'
              ? 'bg-blue-50 text-blue-700 border-b-2 border-blue-600'
              : 'text-gray-600 hover:text-gray-800'
          ]"
        >
          Preview
        </button>
      </div>
    </div>

    <main class="flex-1 flex overflow-hidden relative">
      <div
        v-if="errors.length > 0"
        class="absolute top-0 left-0 right-0 z-10 bg-red-50 border-b border-red-200 px-4 py-2 shadow-sm"
      >
        <div v-for="(error, index) in errors" :key="index" class="text-red-700 text-sm">
          <span v-if="error.line" class="font-mono text-red-600">Line {{ error.line }}: </span>{{ error.message }}
        </div>
      </div>
      <div
        v-if="exportStatus"
        class="absolute top-0 left-0 right-0 z-10 px-4 py-2 shadow-sm text-sm"
        :class="exportStatus.success
          ? 'bg-green-50 border-b border-green-200 text-green-700'
          : 'bg-red-50 border-b border-red-200 text-red-700'"
      >
        {{ exportStatus.message }}
      </div>
      <div class="w-full md:w-1/2 border-r border-gray-300" :class="activeTab === 'editor' ? 'block' : 'hidden md:block'">
        <TabCodeEditor v-model="tabContent" :error-lines="errorLines" :font-size="fontSize" />
      </div>
      <div class="w-full md:w-1/2 bg-white" :class="activeTab === 'preview' ? 'block' : 'hidden md:block'">
        <TabPreview
          :layout="layoutResult"
          :is-loading="isCompiling"
        />
      </div>
    </main>

    <HelpPanel :is-open="showHelpPanel" @close="showHelpPanel = false" />

    <UpdateModal
      :status="updateStatus"
      :tracked-version="updateTrackedVersion"
      :changelog="updateChangelog"
      :is-applying="isApplyingUpdate"
      @download="startDownload"
      @snooze="snoozeUpdate"
      @apply="applyUpdate"
      @dismiss-error="dismissUpdateError"
    />

    <div
      v-if="confirmModalOpen"
      class="fixed inset-0 z-50 flex items-center justify-center"
      @keydown.esc="resolveConfirm(false)"
    >
      <div class="absolute inset-0 bg-black/40" @click="resolveConfirm(false)" />
      <div
        class="relative bg-white rounded-lg shadow-xl p-6 max-w-sm w-full mx-4"
        @click.stop
      >
        <p class="text-sm text-gray-700 mb-5">{{ confirmModalMessage }}</p>
        <div class="flex justify-end gap-3">
          <button
            @click="resolveConfirm(false)"
            class="px-3 py-1.5 text-sm font-medium text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded transition-colors"
          >
            Cancel
          </button>
          <button
            ref="confirmPrimaryBtn"
            @click="resolveConfirm(true)"
            class="px-3 py-1.5 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded transition-colors"
          >
            {{ confirmPrimaryLabel }}
          </button>
        </div>
      </div>
    </div>

    <!-- Three-way quit modal: Save / Discard / Cancel -->
    <div
      v-if="quitModalOpen"
      class="fixed inset-0 z-50 flex items-center justify-center"
      @keydown.esc="resolveQuit('cancel')"
    >
      <div class="absolute inset-0 bg-black/40" @click="resolveQuit('cancel')" />
      <div
        class="relative bg-white rounded-lg shadow-xl p-6 max-w-sm w-full mx-4"
        @click.stop
      >
        <p class="text-sm text-gray-700 mb-5">You have unsaved changes. Save before closing?</p>
        <div class="flex justify-end gap-3">
          <button
            @click="resolveQuit('cancel')"
            class="px-3 py-1.5 text-sm font-medium text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded transition-colors"
          >
            Cancel
          </button>
          <button
            @click="resolveQuit('discard')"
            class="px-3 py-1.5 text-sm font-medium text-red-600 hover:text-red-800 hover:bg-red-50 rounded transition-colors"
          >
            Discard
          </button>
          <button
            ref="quitSaveBtn"
            @click="resolveQuit('save')"
            class="px-3 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
body {
  margin: 0;
  padding: 0;
}

#app {
  max-width: none;
  margin: 0;
  padding: 0;
}

.filename-field {
  font-size: 0.875rem; /* text-sm */
  color: #6b7280;      /* text-gray-500 */
  background: transparent;
  border: none;
  outline: none;
  padding: 0 2px; /* constant padding prevents layout shift when focus ring appears */
  min-width: 8ch;
  width: auto;
}

.filename-field:focus {
  outline: 1px solid #d1d5db; /* gray-300 - subtle focus ring */
  border-radius: 2px;
}
</style>
