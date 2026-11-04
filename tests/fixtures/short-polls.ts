// The checkout lease's retry and the queue's wait for a release, at test speed.
// How often they look decides only how soon a waiting test can go on, and at
// their real pace of once a second these tests spend whole seconds waiting.
//
// Imported by the test files that wait on them. Everything else in those files
// keeps its timing, and none of them waits on a deadline of exactly one second.
const { setTimeout: timeout } = globalThis
globalThis.setTimeout = ((run: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => timeout(run, ms === 1_000 ? 20 : ms, ...rest)) as typeof setTimeout
