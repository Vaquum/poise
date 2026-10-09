import type { ServerResponse } from 'node:http'

/**
 * Which paired devices hold their Link event stream open through the gateway right now. A paired
 * device is not necessarily a running one: Settings shows a device as connected only while this says
 * so. It lives in memory, as the streams do; Poise Link reconnects within seconds of a gateway restart.
 */
export class LinkStreams {
  private readonly open = new Map<string, Set<ServerResponse>>()

  /** Counts `res` as one of `deviceId`'s streams until it closes, then calls `closed`. */
  watch(deviceId: string, res: ServerResponse, closed: () => void): void {
    let streams = this.open.get(deviceId)
    if (!streams) {
      streams = new Set()
      this.open.set(deviceId, streams)
    }
    const own = streams
    own.add(res)
    res.once('close', () => {
      own.delete(res)
      if (own.size === 0) this.open.delete(deviceId)
      closed()
    })
  }

  /** Only a stream the workspace accepted counts: a refusal or a workspace still starting is no connection. */
  connected(deviceId: string): boolean {
    for (const res of this.open.get(deviceId) ?? []) {
      if (res.headersSent && res.statusCode === 200) return true
    }
    return false
  }
}
