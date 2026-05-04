/**
 * advisor-ui — bordered select-panel builders for the /advisor command.
 *
 * Two public functions (showAdvisorPicker, showEffortPicker) share a private
 * buildSelectPanel helper that owns the bordered-container layout and the
 * SelectList theme wiring.
 */

import { DynamicBorder } from '@gsd/pi-coding-agent'
import { Container, SelectList, Spacer, Text } from '@gsd/pi-tui'

const MAX_VISIBLE_ROWS = 10
const NAV_HINT = '↑↓ navigate • enter select • esc cancel'

const ADVISOR_HEADER_TITLE = 'Advisor Tool'
const ADVISOR_HEADER_PROSE_1 =
  'When the active model needs stronger judgment — a complex decision, an ambiguous ' +
  "failure, a problem it's circling without progress — it escalates to the " +
  'advisor model for guidance, then resumes. The advisor runs server-side ' +
  'and uses additional tokens.'
const ADVISOR_HEADER_PROSE_2 =
  'For certain workloads, pairing a faster model as the main model with a ' +
  'more capable one as the advisor gives near-top-tier performance with ' +
  'reduced token usage.'

const EFFORT_HEADER_TITLE = 'Reasoning Level'
const EFFORT_HEADER_PROSE =
  'Choose the reasoning effort level for the advisor. ' +
  'Higher levels produce stronger judgment but use more tokens.'

function selectListTheme(theme) {
  return {
    selectedPrefix: (t) => theme.bg('selectedBg', theme.fg('accent', t)),
    selectedText: (t) => theme.bg('selectedBg', theme.bold(t)),
    description: (t) => theme.fg('muted', t),
    scrollInfo: (t) => theme.fg('dim', t),
    noMatch: (t) => theme.fg('warning', t),
  }
}

function buildSelectPanel(theme, title, proseLines, selectList) {
  const container = new Container()
  const border = () => new DynamicBorder((s) => theme.fg('accent', s))

  container.addChild(border())
  container.addChild(new Spacer(1))
  container.addChild(new Text(theme.fg('accent', theme.bold(title)), 1, 0))
  container.addChild(new Spacer(1))
  for (const line of proseLines) {
    container.addChild(new Text(line, 1, 0))
    container.addChild(new Spacer(1))
  }
  container.addChild(selectList)
  container.addChild(new Spacer(1))
  container.addChild(new Text(theme.fg('dim', NAV_HINT), 1, 0))
  container.addChild(new Spacer(1))
  container.addChild(border())
  return container
}

export async function showAdvisorPicker(ctx, items) {
  return ctx.ui.custom((tui, theme, _kb, done) => {
    const selectList = new SelectList(
      items,
      Math.min(items.length, MAX_VISIBLE_ROWS),
      selectListTheme(theme),
    )
    selectList.onSelect = (item) => done(item.value)
    selectList.onCancel = () => done(null)

    const container = buildSelectPanel(
      theme,
      ADVISOR_HEADER_TITLE,
      [ADVISOR_HEADER_PROSE_1, ADVISOR_HEADER_PROSE_2],
      selectList,
    )

    return {
      render: (w) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        selectList.handleInput(data)
        tui.requestRender()
      },
    }
  })
}

export async function showEffortPicker(
  ctx,
  items,
  currentEffort,
  defaultEffort,
) {
  return ctx.ui.custom((tui, theme, _kb, done) => {
    const selectList = new SelectList(
      items,
      Math.min(items.length, MAX_VISIBLE_ROWS),
      selectListTheme(theme),
    )
    const preferredIdx = currentEffort
      ? items.findIndex((item) => item.value === currentEffort)
      : -1
    selectList.setSelectedIndex(
      preferredIdx >= 0
        ? preferredIdx
        : items.findIndex((item) => item.value === defaultEffort),
    )
    selectList.onSelect = (item) => done(item.value)
    selectList.onCancel = () => done(null)

    const container = buildSelectPanel(
      theme,
      EFFORT_HEADER_TITLE,
      [EFFORT_HEADER_PROSE],
      selectList,
    )

    return {
      render: (w) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        selectList.handleInput(data)
        tui.requestRender()
      },
    }
  })
}
