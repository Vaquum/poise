// Drives Poise's real TypeScript checkout lease (server/chat/checkout-lock.ts)
// from Node so the Caller suite can prove both sides agree on the file, the
// schema and the rules. Poise source is imported read-only from POISE_DIR.
//
//   node --experimental-transform-types --import ./poise-ts-resolver.mjs poise-lock-holder.mjs try <checkout>
//        -> "acquired <token>" (released at once) | "busy <reason> <orphan> <owner_label>"
//   ... acquire <checkout> <hold-seconds>   -> "acquired <token>", holds with heartbeats, then "released"
//   ... read <checkout>                     -> JSON of the row or null
const poise = process.env.POISE_DIR
const { CheckoutLease } = await import(`${poise}/server/chat/checkout-lock.ts`)
const [mode, checkout, arg] = process.argv.slice(2)
const lease = new CheckoutLease(checkout, {
  ownerKind: 'poise:chat', ownerId: 'sess-ts', ownerLabel: 'chat "ts" on chat/x (Poise dev)', instance: 'poise-dev:interop',
})
if (mode === 'try') {
  const r = lease.tryAcquire()
  if (r.acquired) { console.log(`acquired ${r.token}`); lease.release() }
  else console.log(`busy ${r.reason} ${r.orphan} ${r.holder.owner_label}`)
} else if (mode === 'acquire') {
  const r = await lease.acquire()
  console.log(`acquired ${r.token}`)
  await new Promise((resolve) => setTimeout(resolve, Number(arg) * 1000))
  console.log(lease.release() ? 'released' : 'not-ours')
} else if (mode === 'read') {
  console.log(JSON.stringify(lease.read()))
}
