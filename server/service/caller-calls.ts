// `runningCallerCalls` in /api/service/health: the Caller calls this server
// started for agent work that have not finished. Detached launches (behavior
// runs, manual reviews and replays, card chats, /content) are counted from
// spawn to exit where they are spawned; the /consensus debate runs inside its
// request and is counted around it here. Chat turns are `activeChatTurns`.

import { runningCallerLaunches } from '../process'

let debates = 0

export async function countDebate<T>(run: () => Promise<T>): Promise<T> {
  debates += 1
  try {
    return await run()
  } finally {
    debates -= 1
  }
}

export function runningCallerCalls(): number {
  return runningCallerLaunches() + debates
}
