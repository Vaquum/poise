// libuv's thread pool runs every asynchronous file-system call, and its
// default four threads are too few for the server: after a restart a page
// waited behind the startup's own reads. libuv reads the size once, when the
// pool first starts, so each in-process launcher (launch.mjs here,
// scripts/start-production.mjs) imports this module before anything else; the
// server bundle sets the same on its first line for a direct
// `node dist/server.js` (scripts/build-server.mjs). A size set by whoever
// started the process stays.
process.env.UV_THREADPOOL_SIZE ??= '16'
