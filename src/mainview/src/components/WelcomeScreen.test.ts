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
})
