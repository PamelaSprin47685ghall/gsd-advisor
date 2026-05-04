/**
 * advisor tool + /advisor command — Advisor-strategy pattern.
 *
 * Lets the executor model consult a stronger advisor model (e.g. Opus) via an
 * in-process completeSimple() call with the full serialized conversation branch
 * as context. Advisor has no tools, never emits user-facing output, and returns
 * guidance (plan, correction, or stop signal) that the executor resumes with.
 *
 * Default state is OFF — the tool is registered at load but a before_agent_start
 * handler strips it from the active tool list each turn while no advisor model
 * is selected. /advisor opens a selector panel (ctx.ui.custom) to pick an
 * advisor model from ctx.modelRegistry.getAvailable() and toggles the tool in
 * via pi.setActiveTools(). Selection is in-memory and resets each session.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// Host dependencies are lazy-loaded so the module never crashes during init.
let _aiDeps = null
let _aiDepsPromise = null

async function loadAiDeps() {
  if (_aiDeps) return _aiDeps
  if (_aiDepsPromise) return _aiDepsPromise
  _aiDepsPromise = (async () => {
    const [piAi, codingAgent, typebox] = await Promise.all([
      import('@gsd/pi-ai').catch(() => ({})),
      import('@gsd/pi-coding-agent').catch(() => ({})),
      import('@sinclair/typebox').catch(() => ({})),
    ])
    _aiDeps = {
      completeSimple: piAi.completeSimple,
      convertToLlm: codingAgent.convertToLlm,
      Type: typebox.Type,
    }
    return _aiDeps
  })()
  return _aiDepsPromise
}

import { showAdvisorPicker, showEffortPicker } from './advisor-ui.js'

// ---------------------------------------------------------------------------
// Constants — grouped by concern, flat named consts (no namespaced objects)
// ---------------------------------------------------------------------------

// Tool identity
const ADVISOR_TOOL_NAME = 'advisor'
const TOOL_LABEL = 'Advisor'

// Persistence
const CONFIG_DIR = join(homedir(), '.config', 'gsd-advisor')
const ADVISOR_CONFIG_PATH = join(CONFIG_DIR, 'advisor.json')
const CONFIG_FILE_MODE = 0o600

// Selector sentinels
const NO_ADVISOR_VALUE = '__no_advisor__'
const OFF_VALUE = '__off__'

// Effort levels
const BASE_EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high']
const XHIGH_EFFORT_LEVEL = 'xhigh'
const DEFAULT_EFFORT = 'high'
const RECOMMENDED_EFFORT_SUFFIX = '  (recommended)'

// UI
const CHECKMARK = ' ✓'

// Messages (static)
const MSG_ADVISOR_DISABLED = 'Advisor disabled'
const MSG_REQUIRES_INTERACTIVE = '/advisor requires interactive mode'
const MSG_ADVISOR_NUDGE = "Please advise on the executor's situation above."

// Errors (static)
const ERR_NO_MODEL =
  'No advisor model is configured. The user can enable one with the /advisor command.'
const ERR_CALL_ABORTED = 'Advisor call was cancelled before it completed.'
const ERR_EMPTY_RESPONSE = 'Advisor returned no text content.'
const ERR_NO_MODEL_SELECTED = 'no advisor model selected'
const ERR_EMPTY_RESPONSE_DETAIL = 'empty response'
const ERR_ABORTED_DETAIL = 'aborted'
const ERR_UNKNOWN = 'unknown error'

// Errors/messages (parameterized)
const errMisconfigured = (label, err) =>
  `Advisor (${label}) is misconfigured: ${err}`
const errNoApiKey = (label) => `Advisor (${label}) has no API key available.`
const errCallFailed = (err) => `Advisor call failed: ${err ?? ERR_UNKNOWN}`
const errCallThrew = (msg) => `Advisor call threw: ${msg}`
const errSelectionNotFound = (choice) =>
  `Advisor selection not found: ${choice}`
const errModelUnavailable = (key) =>
  `Previously configured advisor model ${key} is no longer available`
const msgAdvisorEnabled = (label, effort) =>
  `Advisor: ${label}${effort ? `, ${effort}` : ''}`
const msgAdvisorRestored = (label, effort) =>
  `Advisor restored: ${label}${effort ? `, ${effort}` : ''}`
const msgConsulting = (label, effort) =>
  `Consulting advisor (${label}${effort ? `, ${effort}` : ''})…`

// ---------------------------------------------------------------------------
// Config file persistence (cross-session)
// ---------------------------------------------------------------------------

function loadAdvisorConfig() {
  if (!existsSync(ADVISOR_CONFIG_PATH)) return {}
  try {
    return JSON.parse(readFileSync(ADVISOR_CONFIG_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

function saveAdvisorConfig(key, effort) {
  const config = {}
  if (key) config.modelKey = key
  if (effort) config.effort = effort
  try {
    mkdirSync(dirname(ADVISOR_CONFIG_PATH), { recursive: true })
    writeFileSync(
      ADVISOR_CONFIG_PATH,
      `${JSON.stringify(config, null, 2)}\n`,
      'utf-8',
    )
    chmodSync(ADVISOR_CONFIG_PATH, CONFIG_FILE_MODE)
  } catch {
    // best effort
  }
}

function parseModelKey(key) {
  const idx = key.indexOf(':')
  if (idx < 1) return undefined
  return { provider: key.slice(0, idx), modelId: key.slice(idx + 1) }
}

// ---------------------------------------------------------------------------
// System prompt — loaded once at module init
// ---------------------------------------------------------------------------

let _systemPrompt = null
function getAdvisorSystemPrompt() {
  if (!_systemPrompt) {
    _systemPrompt = readFileSync(
      fileURLToPath(new URL('./prompts/advisor-system.txt', import.meta.url)),
      'utf-8',
    ).trimEnd()
  }
  return _systemPrompt
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSupportedThinkingLevels(model) {
  const base = [...BASE_EFFORT_LEVELS]
  if (model.capabilities?.supportsXhigh) {
    return [...base, XHIGH_EFFORT_LEVEL]
  }
  return base
}

function modelKey(m) {
  return `${m.provider}:${m.id}`
}

// ---------------------------------------------------------------------------
// Inventory state + serializer
// ---------------------------------------------------------------------------

const ADVISOR_STATE_KEY = Symbol.for('gsd-advisor')

function getAdvisorRuntimeState() {
  const g = globalThis
  let state = g[ADVISOR_STATE_KEY]
  if (!state) {
    state = {}
    g[ADVISOR_STATE_KEY] = state
  }
  return state
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? 'null' : stableStringify(v))).join(',')}]`
  }
  const obj = value
  const entries = []
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k]
    if (v === undefined) continue
    entries.push(`${JSON.stringify(k)}:${stableStringify(v)}`)
  }
  return `{${entries.join(',')}}`
}

function buildInventoryBlock(tools) {
  return tools
    .map(
      (t) =>
        `### ${t.name}\n${t.description}\n\nParameters: ${stableStringify(t.parameters)}`,
    )
    .join('\n\n---\n\n')
}

function stripInflightAdvisorCall(messages) {
  if (messages.length === 0) return messages
  const last = messages[messages.length - 1]
  if (last.role !== 'assistant') return messages
  const filtered = last.content.filter(
    (c) => !(c.type === 'toolCall' && c.name === ADVISOR_TOOL_NAME),
  )
  if (filtered.length === last.content.length) return messages
  if (filtered.length === 0) return messages.slice(0, -1)
  return [...messages.slice(0, -1), { ...last, content: filtered }]
}

function ensureUserTailForAdvisor(messages) {
  if (messages.length === 0) return messages
  const last = messages[messages.length - 1]
  if (last.role !== 'assistant') return messages
  const nudge = {
    role: 'user',
    content: [{ type: 'text', text: MSG_ADVISOR_NUDGE }],
    timestamp: Date.now(),
  }
  return [...messages, nudge]
}

function getInventoryMessage(tools) {
  if (tools.length === 0) return undefined
  const sorted = [...tools].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )
  const signature = sorted.map((t) => t.name).join('|')
  const state = getAdvisorRuntimeState()
  if (state.inventorySignature === signature && state.inventoryMessage) {
    return state.inventoryMessage
  }
  const text = `## Available Executor Tools\n\n${buildInventoryBlock(sorted)}`
  const message = {
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  }
  state.inventorySignature = signature
  state.inventoryMessage = message
  return message
}

// ---------------------------------------------------------------------------
// Module state — in-memory, resets each session
// ---------------------------------------------------------------------------

let selectedAdvisor
let selectedAdvisorEffort

function getAdvisorModel() {
  return selectedAdvisor
}
function setAdvisorModel(model) {
  selectedAdvisor = model
}
function getAdvisorEffort() {
  return selectedAdvisorEffort
}
function setAdvisorEffort(effort) {
  selectedAdvisorEffort = effort
}

// ---------------------------------------------------------------------------
// Session restoration — called from session_start handler
// ---------------------------------------------------------------------------

function restoreAdvisorState(ctx, pi) {
  const config = loadAdvisorConfig()
  if (!config.modelKey) return

  const parsed = parseModelKey(config.modelKey)
  if (!parsed) return

  const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId)
  if (!model) {
    if (ctx.hasUI) {
      ctx.ui.notify(errModelUnavailable(config.modelKey), 'warning')
    }
    return
  }

  setAdvisorModel(model)
  if (config.effort) {
    setAdvisorEffort(config.effort)
  }

  const active = pi.getActiveTools()
  if (!active.includes(ADVISOR_TOOL_NAME)) {
    pi.setActiveTools([...active, ADVISOR_TOOL_NAME])
  }

  if (ctx.hasUI) {
    ctx.ui.notify(msgAdvisorRestored(modelKey(model), config.effort), 'info')
  }
}

// ---------------------------------------------------------------------------
// Core execute logic
// ---------------------------------------------------------------------------

function buildErrorResult(advisorLabel, userText, errorMessage) {
  const effort = getAdvisorEffort()
  return {
    content: [{ type: 'text', text: userText }],
    details: advisorLabel
      ? { advisorModel: advisorLabel, effort, errorMessage }
      : { effort, errorMessage },
  }
}

async function executeAdvisor(ctx, pi, signal, onUpdate) {
  const { completeSimple, convertToLlm } = await loadAiDeps()
  const advisor = getAdvisorModel()
  if (!advisor) {
    return buildErrorResult(undefined, ERR_NO_MODEL, ERR_NO_MODEL_SELECTED)
  }
  const advisorLabel = modelKey(advisor)
  const effort = getAdvisorEffort()

  // Resolve API key via ModelRegistry
  const apiKey = await ctx.modelRegistry.getApiKey(advisor)
  if (!apiKey) {
    return buildErrorResult(
      advisorLabel,
      errNoApiKey(advisorLabel),
      errNoApiKeyDetail(advisor.provider),
    )
  }

  // Live-read the conversation branch every call
  const branch = ctx.sessionManager.getBranch()
  const agentMessages = branch
    .filter((e) => e.type === 'message')
    .map((e) => e.message)
  const branchMessages = ensureUserTailForAdvisor(
    stripInflightAdvisorCall(convertToLlm(agentMessages)),
  )
  const inventoryMessage = getInventoryMessage(pi.getAllTools())
  const messages = inventoryMessage
    ? [inventoryMessage, ...branchMessages]
    : branchMessages

  onUpdate?.({
    content: [{ type: 'text', text: msgConsulting(advisorLabel, effort) }],
    details: { advisorModel: advisorLabel, effort },
  })

  try {
    const response = await completeSimple(
      advisor,
      { systemPrompt: getAdvisorSystemPrompt(), messages, tools: [] },
      { apiKey, signal, reasoning: effort },
    )

    if (response.stopReason === 'aborted') {
      return {
        content: [{ type: 'text', text: ERR_CALL_ABORTED }],
        details: {
          advisorModel: advisorLabel,
          effort,
          usage: response.usage,
          stopReason: response.stopReason,
          errorMessage: response.errorMessage ?? ERR_ABORTED_DETAIL,
        },
      }
    }

    if (response.stopReason === 'error') {
      return {
        content: [{ type: 'text', text: errCallFailed(response.errorMessage) }],
        details: {
          advisorModel: advisorLabel,
          effort,
          usage: response.usage,
          stopReason: response.stopReason,
          errorMessage: response.errorMessage,
        },
      }
    }

    const advisorText = response.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
      .trim()

    if (!advisorText) {
      return {
        content: [{ type: 'text', text: ERR_EMPTY_RESPONSE }],
        details: {
          advisorModel: advisorLabel,
          effort,
          usage: response.usage,
          stopReason: response.stopReason,
          errorMessage: ERR_EMPTY_RESPONSE_DETAIL,
        },
      }
    }

    return {
      content: [{ type: 'text', text: advisorText }],
      details: {
        advisorModel: advisorLabel,
        effort,
        usage: response.usage,
        stopReason: response.stopReason,
      },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return buildErrorResult(advisorLabel, errCallThrew(message), message)
  }
}

const errNoApiKeyDetail = (provider) => `no API key for ${provider}`

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

let AdvisorParams = null

async function ensureAdvisorParams() {
  if (AdvisorParams) return AdvisorParams
  const { Type } = await loadAiDeps()
  if (Type?.Object) {
    AdvisorParams = Type.Object({})
  } else {
    AdvisorParams = { type: 'object', properties: {} }
  }
  return AdvisorParams
}

const ADVISOR_DESCRIPTION =
  'Escalate to a stronger reviewer model for guidance. When you need ' +
  'stronger judgment — a complex decision, an ambiguous failure, a problem ' +
  "you're circling without progress — escalate to the advisor model for " +
  'guidance, then resume. Takes NO parameters — when you call advisor(), ' +
  'your entire conversation history is automatically forwarded. The advisor ' +
  "sees the task, every tool call you've made, every result you've seen."

const ADVISOR_PROMPT_SNIPPET =
  'Escalate to a stronger reviewer model for guidance when stuck, before substantive work, or before declaring done'

const ADVISOR_PROMPT_GUIDELINES = [
  "Call `advisor` BEFORE substantive work — before writing, before committing to an interpretation, before building on an assumption. Orientation (finding files, fetching a source, seeing what's there) is not substantive work; writing, editing, and declaring an answer are.",
  "Also call `advisor` when you believe the task is complete. BEFORE this call, make your deliverable durable: write the file, save the result, commit the change. The advisor call takes time; if the session ends during it, a durable result persists and an unwritten one doesn't.",
  "Also call `advisor` when stuck — errors recurring, approach not converging, results that don't fit — or when considering a change of approach.",
  "On tasks longer than a few steps, call `advisor` at least once before committing to an approach and once before declaring done. On short reactive tasks where the next action is dictated by tool output you just read, you don't need to keep calling — the advisor adds most of its value on the first call, before the approach crystallizes.",
  "Give the advisor's advice serious weight. If you follow a step and it fails empirically, or you have primary-source evidence that contradicts a specific claim, adapt — a passing self-test is not evidence the advice is wrong, it's evidence your test doesn't check what the advice is checking.",
  'If you\'ve already retrieved data pointing one way and the advisor points another, don\'t silently switch — surface the conflict in one more `advisor` call ("I found X, you suggest Y, which constraint breaks the tie?"). A reconcile call is cheaper than committing to the wrong branch.',
]

async function registerAdvisorTool(pi) {
  const params = await ensureAdvisorParams()
  pi.registerTool({
    name: ADVISOR_TOOL_NAME,
    label: TOOL_LABEL,
    description: ADVISOR_DESCRIPTION,
    promptSnippet: ADVISOR_PROMPT_SNIPPET,
    promptGuidelines: ADVISOR_PROMPT_GUIDELINES,
    parameters: params,

    async execute(_toolCallId, _params, signal, onUpdate, ctx) {
      return executeAdvisor(ctx, pi, signal, onUpdate)
    },
  })
}

// ---------------------------------------------------------------------------
// before_agent_start handler
// ---------------------------------------------------------------------------

function registerAdvisorBeforeAgentStart(pi) {
  pi.on('before_agent_start', async () => {
    if (!getAdvisorModel()) {
      const active = pi.getActiveTools()
      if (active.includes(ADVISOR_TOOL_NAME)) {
        pi.setActiveTools(active.filter((n) => n !== ADVISOR_TOOL_NAME))
      }
    }
  })
}

// ---------------------------------------------------------------------------
// /advisor slash command
// ---------------------------------------------------------------------------

function registerAdvisorCommand(pi) {
  pi.registerCommand('advisor', {
    description: 'Configure the advisor model for the advisor-strategy pattern',
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify(MSG_REQUIRES_INTERACTIVE, 'error')
        return
      }

      const availableModels = ctx.modelRegistry.getAvailable()
      const current = getAdvisorModel()
      const currentKey = current ? modelKey(current) : undefined

      const items = availableModels.map((m) => {
        const key = modelKey(m)
        const check = key === currentKey ? CHECKMARK : ''
        return { value: key, label: `${m.name}  (${m.provider})${check}` }
      })
      items.push({
        value: NO_ADVISOR_VALUE,
        label:
          currentKey === undefined ? `No advisor${CHECKMARK}` : 'No advisor',
      })

      const choice = await showAdvisorPicker(ctx, items)
      if (!choice) return

      const activeTools = pi.getActiveTools()
      const activeHas = activeTools.includes(ADVISOR_TOOL_NAME)

      if (choice === NO_ADVISOR_VALUE) {
        setAdvisorModel(undefined)
        setAdvisorEffort(undefined)
        saveAdvisorConfig(undefined, undefined)
        if (activeHas) {
          pi.setActiveTools(activeTools.filter((n) => n !== ADVISOR_TOOL_NAME))
        }
        ctx.ui.notify(MSG_ADVISOR_DISABLED, 'info')
        return
      }

      const picked = availableModels.find((m) => modelKey(m) === choice)
      if (!picked) {
        ctx.ui.notify(errSelectionNotFound(choice), 'error')
        return
      }

      // Effort picker — only for reasoning-capable models
      let effortChoice
      if (picked.reasoning) {
        const levels = getSupportedThinkingLevels(picked).includes('xhigh')
          ? [...BASE_EFFORT_LEVELS, XHIGH_EFFORT_LEVEL]
          : BASE_EFFORT_LEVELS

        const effortItems = [
          { value: OFF_VALUE, label: 'off' },
          ...levels.map((level) => ({
            value: level,
            label:
              level === DEFAULT_EFFORT
                ? `${level}${RECOMMENDED_EFFORT_SUFFIX}`
                : level,
          })),
        ]

        const effortResult = await showEffortPicker(
          ctx,
          effortItems,
          getAdvisorEffort(),
          DEFAULT_EFFORT,
        )
        if (!effortResult) return
        effortChoice = effortResult === OFF_VALUE ? undefined : effortResult
      }

      setAdvisorEffort(effortChoice)
      setAdvisorModel(picked)
      saveAdvisorConfig(modelKey(picked), effortChoice)
      if (!activeHas) {
        pi.setActiveTools([...activeTools, ADVISOR_TOOL_NAME])
      }
      ctx.ui.notify(msgAdvisorEnabled(modelKey(picked), effortChoice), 'info')
    },
  })
}

export {
  registerAdvisorTool,
  registerAdvisorCommand,
  registerAdvisorBeforeAgentStart,
  restoreAdvisorState,
}
