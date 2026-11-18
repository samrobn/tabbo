import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import UpdateModal from './UpdateModal.vue'

function mountDownloading(progress: number | null) {
  return mount(UpdateModal, {
    props: { status: { phase: 'downloading', progress }, trackedVersion: '1.2.3', changelog: null, isApplying: false },
    global: { stubs: { teleport: true, transition: false } },
  })
}

describe('UpdateModal downloading phase', () => {
  it('shows a progress bar and percentage when the updater reports progress', () => {
    const wrapper = mountDownloading(42)
    const bar = wrapper.find('[role="progressbar"]')
    expect(bar.exists()).toBe(true)
    expect(bar.attributes('aria-valuenow')).toBe('42')
    expect(wrapper.text()).toContain('42%')
  })

  // Electrobun 2.x never reports progress. A full-width bar would look finished
  // (and stands still under Reduce Motion), so show the text alone.
  it('shows no bar when there is no progress figure', () => {
    const wrapper = mountDownloading(null)
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Downloading update')
    expect(wrapper.text()).toContain('Downloading v1.2.3.')
  })
})
