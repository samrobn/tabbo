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
import { addRecentDir } from '../../shared/recent-dirs'
import { startCaptureWorker } from './composables/useCaptureWorker'

// CSS px per pt at the canonical 96 DPI reference pixel density (1pt = 1/72 in, 1px = 1/96 in)
const PT_TO_PX = 96 / 72

const basename = (path: string) => path.split("/").pop() ?? path
// Drop the last extension (any: .tab/.txt/…). The title menu edits the stem; ".tab" is a fixed suffix.
const stripExt = (name: string) => name.replace(/\.[^/.]+$/, "")
const dirname = (path: string) => { const slash = path.lastIndexOf("/"); return slash <= 0 ? path : path.slice(0, slash) }

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
          case 'revert': revertFile(); break
          case 'exportPdf': exportPdf(); break
          case 'new': clearDraft(); break
          case 'newFromTemplate': showTemplatePicker.value = true; nextTick(() => templatePickerRoot.value?.focus()); break
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

// Resizable editor/preview split (desktop only; mobile uses the tab switcher above).
// editorWidthPct drives the editor pane's width as a % of the split container; the
// preview fills the rest. Persisted across launches via localStorage (a UI pref, kept
// out of bun Settings to avoid an RPC round-trip for pure-webview state).
const SPLIT_SNAP_PCT = 2 // drag within this of centre locks to exactly 50/50 (double-click also resets)
const editorWidthPct = ref(readPersistedSplitPct())
const splitContainer = ref<HTMLElement | null>(null)

function readPersistedSplitPct(): number {
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEYS.SPLIT))
    if (Number.isFinite(stored) && stored >= 20 && stored <= 80) return stored
  } catch { /* localStorage unavailable */ }
  return 50
}
function persistSplit(): void {
  try { localStorage.setItem(STORAGE_KEYS.SPLIT, String(editorWidthPct.value)) } catch { /* localStorage unavailable */ }
}
function resetSplit(): void {
  editorWidthPct.value = 50
  persistSplit()
}

function startSplitDrag(event: PointerEvent): void {
  event.preventDefault()
  const container = splitContainer.value
  if (!container) return
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'col-resize'
  const onMove = (ev: PointerEvent) => {
    const rect = container.getBoundingClientRect()
    let pct = ((ev.clientX - rect.left) / rect.width) * 100
    if (Math.abs(pct - 50) < SPLIT_SNAP_PCT) pct = 50 // detent at centre
    editorWidthPct.value = Math.min(80, Math.max(20, pct))
  }
  const onUp = () => {
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    persistSplit()
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp) // touch interrupt / capture loss → restore body styles, drop listeners
}
// Reduced from 1500ms: getLayout resolves in milliseconds via the long-lived worker
const compileDebounceMs = 100
const currentFilename = ref<string>('untitled.tab')
const currentFilePath = ref<string | null>(null)
const isDirty = ref<boolean>(false)
const pendingTargetDir = ref<string | null>(null)
const recentSaveDirs = ref<string[]>([])

// Document-title popover (in-Vue; window.confirm is broken in this WKWebView)
const titleMenuOpen = ref<boolean>(false)
const draftStem = ref<string>('')           // filename without extension; ".tab" is a fixed, uneditable suffix
const draftDir = ref<string>('')            // selected folder while the popover is open (absolute)
const titleNameInput = ref<HTMLInputElement | null>(null)
// Dirty baseline captured when the popover opens (module-level, like the skip guards):
let titleBaseName = ''
const titleBaseDir = ref<string>('') // reactive: whereOptions keeps the open-time effective folder offered
const showTemplatePicker = ref<boolean>(false)
const templatePickerRoot = ref<HTMLElement | null>(null)
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

// Load content into the editor from a non-keystroke source (open, example,
// reopen-last, draft restore, New). Sets the one-shot watcher guards BEFORE
// assigning tabContent so the content watcher consumes them on its next run -
// a guard set *after* the assignment is left dangling and swallows the next
// real edit instead (the cause of the "first keystroke after open is not
// compiled" bug). Owning the guard-before-assign order here makes correctness
// structural: every load path gets it for free rather than re-stating it.
//   skipCompile (default true): suppress the watcher's debounced compile.
//     Callers that need a preview drive it themselves (immediate getLayout, or
//     the launch compile in onMounted); New passes false so the default
//     document still renders via the watcher.
//   dirty (default false): mark the buffer unsaved. Only a restored draft does.
function loadFileIntoEditor(
  content: string,
  filename: string,
  path: string | null,
  opts: { dirty?: boolean; skipCompile?: boolean } = {},
): void {
  const { dirty = false, skipCompile = true } = opts
  skipNextDirtyMark = true
  if (skipCompile) skipNextCompile = true
  layoutResult.value = null
  tabContent.value = content
  currentFilename.value = filename
  currentFilePath.value = path
  isDirty.value = dirty
  pendingTargetDir.value = null
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

// Revert: discard unsaved changes by reloading the file from disk. Only meaningful for a
// saved file with edits - an untitled doc (no path) has no saved version to revert to, so
// it is a no-op. Reloading via loadFileIntoEditor clears every dirty source at once:
// content, a staged rename, and a staged target folder.
async function revertFile(): Promise<void> {
  if (!currentFilePath.value || !isDirty.value) return
  if (!(await askConfirm('Discard unsaved changes and restore the last saved version?', 'Discard Changes'))) return
  try {
    const file = await electrobun.rpc!.request.readFile({ path: currentFilePath.value })
    if (!file) { showExportStatus(false, 'Could not read file to revert'); return }
    loadFileIntoEditor(file.content, file.filename, currentFilePath.value)
    saveToLocalStorage() // clean now ⇒ clears the crash-recovery draft
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null }
    getLayout()
  } catch (error) {
    console.error('Failed to revert file:', error)
    showExportStatus(false, 'Revert failed')
  }
}

// File operations via native RPC
async function openFile(): Promise<void> {
  if (isDirty.value && !(await askConfirm('You have unsaved changes. Open another file and discard them?'))) {
    return
  }
  try {
    const result = await electrobun.rpc!.request.openFile({})
    if (!result) return

    loadFileIntoEditor(result.content, result.filename, result.path)
    saveToLocalStorage()
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null }
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
    const target = await electrobun.rpc!.request.previewSaveTarget({
      filename: currentFilename.value,
      currentPath: currentFilePath.value,
      targetDir: pendingTargetDir.value,
    })
    const targetIsNewFile = target !== null && target !== currentFilePath.value
    // One confirm that states the real consequence: replacing an existing file, or a plain copy.
    // Checking existence here (not relying on bun's second needs-overwrite-confirm round-trip) avoids
    // a fragile two-modal sequence and never lets a clobber read as a benign "save a copy".
    let overwriteConfirmed = false
    if (targetIsNewFile && !opts.skipCopyConfirm) {
      const willReplace = target ? await electrobun.rpc!.request.fileExists({ path: target }) : false
      const ok = await askConfirm(
        willReplace ? `A file already exists at ${target}. Replace it?` : `Save a copy to ${target}?`,
        willReplace ? 'Replace' : 'Save copy',
      )
      if (!ok) return false
      overwriteConfirmed = willReplace
    }

    const result = await electrobun.rpc!.request.saveFile({
      content: tabContent.value,
      filename: currentFilename.value,
      currentPath: currentFilePath.value,
      targetDir: pendingTargetDir.value,
      confirmOverwrite: overwriteConfirmed,
    })
    return await applySaveResult(result, overwriteConfirmed)
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
    pendingTargetDir.value = null
    const newRecents = addRecentDir(recentSaveDirs.value, dirname(result.path))
    recentSaveDirs.value = newRecents
    try {
      await electrobun.rpc!.request.updateSettings({ lastOpenedFile: result.path, recentSaveDirs: newRecents })
    } catch {
      // Best-effort: a settings-write failure must not turn a successful save into
      // a reported failure or block the quit flow.
    }
    // No success toast: the Edited badge clearing is the save confirmation. Failures still toast.
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
      targetDir: pendingTargetDir.value,
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
    localStorage.removeItem(STORAGE_KEYS.TARGETDIR)
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
    localStorage.setItem(STORAGE_KEYS.TARGETDIR, pendingTargetDir.value ?? "")
  } catch {
    // localStorage may be unavailable or full
  }
}

async function openTitleMenu(): Promise<void> {
  const stem = stripExt(currentFilename.value)
  draftStem.value = stem
  const preview = await electrobun.rpc!.request.previewSaveTarget({
    filename: `${stem}.tab`,
    currentPath: currentFilePath.value,
    targetDir: pendingTargetDir.value,
  })
  // Effective folder = where it would save right now. Always present + selected.
  const effectiveDir = preview ? dirname(preview) : (recentSaveDirs.value[0] ?? '')
  draftDir.value = effectiveDir
  titleBaseName = currentFilename.value
  titleBaseDir.value = effectiveDir
  titleMenuOpen.value = true
  nextTick(() => titleNameInput.value?.focus())
}

function commitTitleMenu(): void {
  if (!titleMenuOpen.value) return
  // Clean the stem so "<stem>.tab" can never be an invalid name: path separators are stripped
  // live (onStemInput); here we collapse internal ".." and trim leading/trailing dots+space.
  // An empty result ⇒ no rename, so we never write a blank/invalid filename - which is why the
  // popover needs no "invalid name" feedback. deriveTabFilename (bun) stays the trust-boundary backstop.
  // No change ⇒ keep the original filename verbatim, so an opened ".txt" left untouched stays ".txt".
  const newStem = draftStem.value.replace(/^[\s.]+|[\s.]+$/g, '').replace(/\.{2,}/g, '.')
  if (newStem && newStem !== stripExt(titleBaseName)) {
    currentFilename.value = `${newStem}.tab`
  }
  // Stage the folder only when moved off the effective baseline (null ⇒ default resolution).
  if (draftDir.value !== titleBaseDir.value) pendingTargetDir.value = draftDir.value
  // Staged rename/relocate is unsaved state - mark dirty so the quit warning fires.
  if (currentFilename.value !== titleBaseName || draftDir.value !== titleBaseDir.value) {
    isDirty.value = true
    saveToLocalStorage()
  }
  titleMenuOpen.value = false
}

function cancelTitleMenu(): void {
  titleMenuOpen.value = false // drafts are reseeded on next open; nothing to clear
}

// Strip path separators as typed - they can never be a valid filename character, and removing
// them keeps the stem inherently valid (the remaining dot/empty cases are cleaned at commit).
function onStemInput(event: Event): void {
  draftStem.value = (event.target as HTMLInputElement).value.replace(/[/\\]/g, '')
}

function onWhereSelect(event: Event): void {
  draftDir.value = (event.target as HTMLSelectElement).value
}

async function chooseFolderClick(): Promise<void> {
  const dir = await electrobun.rpc!.request.chooseFolder({})
  if (dir) draftDir.value = dir // cancel/fail ⇒ draftDir unchanged, the select keeps its current value
}

// MINIMAL: Where shows absolute paths; home-relative (~) prettifying needs the home dir from bun, deferred.
const whereOptions = computed(() => {
  const opts: string[] = []
  // Effective (open-time) folder is always offered, even after the user picks another.
  if (titleBaseDir.value) opts.push(titleBaseDir.value)
  if (draftDir.value && !opts.includes(draftDir.value)) opts.push(draftDir.value)
  for (const dir of recentSaveDirs.value) if (!opts.includes(dir)) opts.push(dir)
  return opts
})

// Reopen the last file from disk, or leave the default blank document as-is.
// `settings` is passed in from onMounted - do NOT call getSettings again here.
async function reopenLast(settings: Settings): Promise<void> {
  const lastPath = settings.lastOpenedFile
  if (!lastPath) return
  try {
    const file = await electrobun.rpc!.request.readFile({ path: lastPath })
    if (!file) return  // missing or unreadable
    // Supply the path explicitly - readFile returns content+filename only.
    // Passing lastPath here is what makes the reopened file round-trip on Save
    // without falling back to a new copy in ~/Documents/Tabbo. No explicit
    // compile: the launch compile in onMounted renders the reopened file.
    loadFileIntoEditor(file.content, file.filename, lastPath)
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
      // Resolve the path before loading: only keep it if the file still exists,
      // so a stale path can't make a restored draft falsely round-trip on Save.
      let resolvedPath: string | null = null
      if (savedPath) {
        try {
          const exists = await electrobun.rpc!.request.fileExists({ path: savedPath })
          resolvedPath = exists ? savedPath : null
        } catch {
          resolvedPath = null
        }
      }
      // A restored draft is unsaved work - dirty:true so the quit warning fires
      // and the autosave keeps the draft alive during the session. No explicit
      // compile: the launch compile in onMounted renders the restored draft.
      loadFileIntoEditor(draftContent, savedFilename || currentFilename.value, resolvedPath, { dirty: true })
      const savedDir = localStorage.getItem(STORAGE_KEYS.TARGETDIR) || ""
      if (savedDir) pendingTargetDir.value = savedDir
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
  // skipCompile:false - unlike the other load paths, New drives no explicit
  // compile, so the content watcher must run the debounced compile to render
  // the default document.
  loadFileIntoEditor(DEFAULT_TAB_CONTENT, 'untitled.tab', null, { skipCompile: false })
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
    loadFileIntoEditor(example.content, `${exampleName.toLowerCase()}.tab`, null)
    showTemplatePicker.value = false
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
  let settings: Settings = { fontSize: 14, theme: 'light' as const, lastOpenedFile: null, recentSaveDirs: [] }
  try {
    settings = await electrobun.rpc!.request.getSettings({})
    fontSize.value = settings.fontSize
    recentSaveDirs.value = settings.recentSaveDirs ?? []
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

    <main ref="splitContainer" class="flex-1 flex overflow-hidden relative">
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
      <div
        class="w-full md:w-[var(--editor-width)] md:shrink-0"
        :style="{ '--editor-width': editorWidthPct + '%' }"
        :class="activeTab === 'editor' ? 'block' : 'hidden md:block'"
      >
        <TabCodeEditor v-model="tabContent" :error-lines="errorLines" :font-size="fontSize">
          <template #header>
            <div class="relative">
              <button
                @click="openTitleMenu()"
                class="px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-200 rounded transition-colors flex items-center gap-1"
                aria-label="Document name and location"
              >
                <span>{{ currentFilename }}</span>
                <Transition name="edited-fade">
                  <span v-if="isDirty" class="text-xs text-gray-400 font-medium">Edited</span>
                </Transition>
                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              <template v-if="titleMenuOpen">
                <div class="title-menu-backdrop" @click="commitTitleMenu" />
                <div class="title-menu-popover" @click.stop>
                  <label class="title-menu-row">
                    <span class="title-menu-label">Name</span>
                    <span class="title-menu-input title-menu-name-field">
                      <input
                        ref="titleNameInput"
                        class="title-menu-stem"
                        :value="draftStem"
                        :size="Math.max(draftStem.length, 1)"
                        spellcheck="false"
                        aria-label="Document name (without extension; saved as .tab)"
                        @input="onStemInput"
                        @keydown.enter="commitTitleMenu"
                        @keydown.esc="cancelTitleMenu"
                      />
                      <span class="title-menu-ext" aria-hidden="true">.tab</span>
                    </span>
                  </label>
                  <div class="title-menu-row">
                    <span class="title-menu-label">Where</span>
                    <select
                      class="title-menu-input"
                      :value="draftDir"
                      aria-label="Save folder"
                      @change="onWhereSelect"
                    >
                      <option v-for="dir in whereOptions" :key="dir" :value="dir">{{ dir }}</option>
                    </select>
                    <button type="button" class="title-menu-choose" @click="chooseFolderClick">Choose…</button>
                  </div>
                </div>
              </template>
            </div>
          </template>
        </TabCodeEditor>
      </div>
      <!-- Draggable divider (desktop only); mobile switches panes via the tab bar -->
      <div
        class="hidden md:block shrink-0 w-1.5 bg-gray-300 hover:bg-blue-400 cursor-col-resize transition-colors"
        @pointerdown="startSplitDrag"
        @dblclick="resetSplit"
        title="Drag to resize · double-click to reset"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize editor and preview"
      />
      <div class="w-full md:flex-1 md:min-w-0 bg-white" :class="activeTab === 'preview' ? 'block' : 'hidden md:block'">
        <TabPreview
          :layout="layoutResult"
          :is-loading="isCompiling"
        />
      </div>
    </main>

    <!-- New from Template picker (opened from the File menu) -->
    <div
      v-if="showTemplatePicker"
      ref="templatePickerRoot"
      tabindex="-1"
      class="fixed inset-0 z-50 flex items-center justify-center outline-none"
      @keydown.esc="showTemplatePicker = false"
    >
      <div class="absolute inset-0 bg-black/40" @click="showTemplatePicker = false" />
      <div class="relative bg-white rounded-lg shadow-xl w-full max-w-sm mx-4 overflow-hidden" @click.stop>
        <div class="px-4 py-3 border-b border-gray-200 text-sm font-medium text-gray-700">New from Template</div>
        <button
          v-for="example in examples"
          :key="example.name"
          @click="loadExample(example.name)"
          class="w-full px-4 py-2 text-left hover:bg-gray-100"
        >
          <div class="font-medium text-gray-800 text-sm">{{ example.name }}</div>
          <div class="text-xs text-gray-500">{{ example.description }}</div>
        </button>
      </div>
    </div>

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

.title-menu-backdrop { position: fixed; inset: 0; z-index: 40; }
.title-menu-popover {
  position: absolute;
  top: 100%;
  left: 0;
  margin-top: 6px;
  z-index: 50;
  width: 22rem;
  background: #fff;
  border-radius: 0.5rem;
  box-shadow: 0 10px 25px rgba(0,0,0,0.18);
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.title-menu-row { display: flex; align-items: center; gap: 0.5rem; }
.title-menu-label { width: 3.5rem; font-size: 0.8rem; color: #6b7280; /* gray-500 */ }
.title-menu-input {
  flex: 1;
  min-width: 0;
  height: 1.875rem; /* explicit + border-box so the native <select> and the Name box render equal height */
  box-sizing: border-box;
  font-size: 0.875rem;
  padding: 4px 6px;
  border: 1px solid #d1d5db; /* gray-300 */
  border-radius: 4px;
  outline: none;
}
.title-menu-input:focus,
.title-menu-name-field:focus-within { border-color: #9ca3af; /* gray-400 */ }
/* Name field: a borderless auto-sizing stem input with a fixed, muted ".tab" suffix hugging the text. */
.title-menu-name-field { display: inline-flex; align-items: center; }
.title-menu-stem {
  flex: 0 1 auto;
  min-width: 2ch;
  max-width: 100%;
  field-sizing: content; /* grow to the typed text (WebKit 17.4+); :size attr is the fallback */
  border: none;
  outline: none;
  margin: 0;
  padding: 0;
  font: inherit;
  color: inherit;
  background: transparent;
}
.title-menu-ext {
  color: #9ca3af; /* gray-400 - muted, signals the extension is fixed/uneditable */
  user-select: none;
  pointer-events: none;
  white-space: pre;
}
.title-menu-choose {
  flex: 0 0 auto;
  height: 1.875rem; /* match the select/name box height */
  box-sizing: border-box;
  padding: 0 0.6rem;
  font-size: 0.8rem;
  color: #374151; /* gray-700 */
  background: #f3f4f6; /* gray-100 */
  border: 1px solid #d1d5db; /* gray-300 */
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
}
.title-menu-choose:hover { background: #e5e7eb; /* gray-200 */ }
/* Edited marker: appears instantly on edit; on save it fades AND collapses its box, so the
   chevron slides smoothly to settle by the filename instead of snapping. The slide (max-width +
   negative margin to absorb the flex gap) starts just after the fade and finishes before it,
   per the requested timing; opacity is near-zero by the time the box clips, so it reads as a fade. */
.edited-fade-leave-active {
  transition:
    opacity 0.3s ease,
    max-width 0.22s ease 0.06s,
    margin-left 0.22s ease 0.06s;
  overflow: hidden;
  white-space: nowrap;
  max-width: 3rem;
}
.edited-fade-leave-to { opacity: 0; max-width: 0; margin-left: -0.25rem; }
</style>
