// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { installWindowInset } from '../src/client/window-inset.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
  document.body.removeAttribute('data-dsh-desktop-platform')
  window.history.replaceState(null, '', '/')
})

it('tracks Windows content position across resize and stops on disposal', async () => {
  vi.useFakeTimers()
  window.history.replaceState(null, '', '/?dsh-desktop-platform=win32')
  const view = document.createElement('div')
  document.body.append(view)
  let top = 0
  vi.spyOn(view, 'getBoundingClientRect').mockImplementation(() => ({ top }) as DOMRect)
  const dispose = installWindowInset(view)
  await vi.advanceTimersByTimeAsync(30)
  expect(view.hasAttribute('data-dsh-atb-windows')).toBe(true)
  expect(view.style.getPropertyValue('--dsh-atb-viewport-top')).toBe('0px')
  // A shell with its own titlebar must not receive another full caption inset.
  top = 36
  window.dispatchEvent(new Event('resize'))
  await vi.advanceTimersByTimeAsync(30)
  expect(view.style.getPropertyValue('--dsh-atb-viewport-top')).toBe('36px')
  dispose()
  top = 0
  window.dispatchEvent(new Event('resize'))
  await vi.advanceTimersByTimeAsync(30)
  expect(view.hasAttribute('data-dsh-atb-windows')).toBe(false)
  expect(view.style.getPropertyValue('--dsh-atb-viewport-top')).toBe('')
})

it('leaves Web and macOS alone, handles late Desktop activation and removal', async () => {
  vi.useFakeTimers()
  const view = document.createElement('div')
  document.body.append(view)
  const dispose = installWindowInset(view)
  await vi.advanceTimersByTimeAsync(30)
  expect(view.hasAttribute('data-dsh-atb-windows')).toBe(false)
  document.body.setAttribute('data-dsh-desktop-platform', 'darwin')
  await vi.advanceTimersByTimeAsync(30)
  expect(view.hasAttribute('data-dsh-atb-windows')).toBe(false)
  document.body.setAttribute('data-dsh-desktop-platform', 'win32')
  await vi.advanceTimersByTimeAsync(30)
  expect(view.hasAttribute('data-dsh-atb-windows')).toBe(true)
  document.body.removeAttribute('data-dsh-desktop-platform')
  await vi.advanceTimersByTimeAsync(30)
  expect(view.hasAttribute('data-dsh-atb-windows')).toBe(false)
  dispose()
})
