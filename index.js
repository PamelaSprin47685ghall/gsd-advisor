import { ensureBundledExtensionPath } from './src/self-injection.js'
import {
  registerAdvisorBeforeAgentStart,
  registerAdvisorCommand,
  registerAdvisorTool,
  restoreAdvisorState,
} from './src/advisor.js'

ensureBundledExtensionPath(import.meta.url)

const registeredPluginApis = new WeakSet()

export default function (pi) {
  if (registeredPluginApis.has(pi)) return

  registerAdvisorTool(pi)
  registerAdvisorCommand(pi)
  registerAdvisorBeforeAgentStart(pi)

  pi.on('session_start', async (_event, ctx) => {
    restoreAdvisorState(ctx, pi)
  })
}
