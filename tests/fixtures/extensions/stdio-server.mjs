// A minimal stdio MCP server for Extensions tests: two tools, one of which
// answers with an environment value so a test can see what was delivered.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const server = new McpServer({ name: 'poise-fixture', version: '1.0.0' })
server.registerTool('echo_token', { description: 'Returns the PROBE_TOKEN it was started with.' }, async () => ({ content: [{ type: 'text', text: process.env.PROBE_TOKEN ?? 'missing' }] }))
server.registerTool('ping', { description: 'Answers pong.' }, async () => ({ content: [{ type: 'text', text: 'pong' }] }))
await server.connect(new StdioServerTransport())
