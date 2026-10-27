import { parentPort } from 'node:worker_threads'
parentPort.on('message', ({ id, request }) => {
  if (request.filter.search === 'hold') return
  parentPort.postMessage({ id, reply: { status: 200, contentType: 'application/json', body: request.filter.search === 'large' ? 'x'.repeat(8 * 1024 * 1024 - 100) : '{"version":1}' } })
})
