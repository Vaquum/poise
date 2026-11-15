import { channel } from 'node:diagnostics_channel'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

// Keep the compiled CLI's refusal unread until its real socket write completes.
channel('net.client.socket').subscribe(({ socket }) => {
  const trace = (event) => appendFileSync(join(process.env.POISE_GATEWAY_DATA, 'client-order.jsonl'), JSON.stringify(event) + '\n')
  socket.prependOnceListener('connect', () => socket.pause())
  socket.prependListener('data', (chunk) => trace({ reply: chunk.toString() }))
  socket.on('error', (error) => trace({ error: error.code }))
  const end = socket.end
  socket.end = function (frame, ...args) {
    if (!Buffer.isBuffer(frame)) return end.call(socket, frame, ...args)
    trace({ frame: frame.toString() })
    setTimeout(() => end.call(socket, frame, (error) => {
      trace({ write: error?.code ?? 'ok' })
      socket.resume()
    }), 50)
    return socket
  }
})
