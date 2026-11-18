import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import WelcomeScreen from './WelcomeScreen.vue'

describe('WelcomeScreen', () => {
  it('renders the three action buttons in order', () => {
    const wrapper = mount(WelcomeScreen)
    const labels = wrapper.findAll('button').map(b => b.text())
    expect(labels).toEqual(['New file', 'Open…', 'New from template'])
  })

  it('emits new / open / template when each button is clicked', async () => {
    const wrapper = mount(WelcomeScreen)
    const buttons = wrapper.findAll('button')
    await buttons[0].trigger('click')
    await buttons[1].trigger('click')
    await buttons[2].trigger('click')
    expect(wrapper.emitted('new')).toHaveLength(1)
    expect(wrapper.emitted('open')).toHaveLength(1)
    expect(wrapper.emitted('template')).toHaveLength(1)
  })

  it('lists recent files newest first, at most five, and emits openRecent with the path', async () => {
    const recentFiles = ['/u/test/a/One.tab', '/u/test/b/Two.tab', '/u/test/c/3.tab', '/u/test/d/4.tab', '/u/test/e/5.tab', '/u/test/f/6.tab']
    const wrapper = mount(WelcomeScreen, { props: { recentFiles } })
    const rows = wrapper.findAll('section button')
    expect(rows.map((row) => row.attributes('title'))).toEqual(recentFiles.slice(0, 5))
    expect(rows[0].text()).toContain('One.tab')
    expect(rows[0].text()).toContain('/u/test/a')
    await rows[1].trigger('click')
    const clickedArgs = ['/u/test/b/Two.tab']
    expect(wrapper.emitted('openRecent')).toEqual([clickedArgs])
  })

  it('shows no recent section when there are none', () => {
    expect(mount(WelcomeScreen).find('section').exists()).toBe(false)
  })
})
