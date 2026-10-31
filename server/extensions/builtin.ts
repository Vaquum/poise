// Built-in directory entries: servers Poise supports whether or not the
// official MCP Registry lists them. They lead the directory ahead of the
// mirror, install like any directory server, and shadow a mirror row of the
// same name, so what Poise ships is what the person gets.

import type { DirectoryEntry } from './types'

/** Remote Desktop Commander's hosted MCP relay (Streamable HTTP, OAuth):
 *  chats reach the files, terminal, search and code tools of every machine
 *  the person paired. Checked against the live metadata (October 2026): the
 *  endpoint answers 401 with a resource-metadata challenge, and its
 *  authorization server supports dynamic client registration, PKCE (S256)
 *  and public clients, which is what Poise's OAuth sign-in needs. */
export const REMOTE_DESKTOP_COMMANDER: DirectoryEntry = {
  name: 'app.desktopcommander/remote-desktop-commander',
  title: 'Remote Desktop Commander',
  description: 'Give chats your computers’ files, terminal, search and code tools through Desktop Commander’s hosted relay. On each machine run `npx @wonderwhy-er/desktop-commander@latest remote` to pair it; after adding, Sign in with the same account.',
  version: '1.0',
  publisher: 'desktopcommander.app',
  websiteUrl: 'https://mcp.desktopcommander.app',
  repositoryUrl: 'https://github.com/desktop-commander/remote-desktop-commander',
  builtin: true,
  options: [
    { id: 'remote-0', kind: 'remote', transport: 'http', summary: 'https://mcp.desktopcommander.app/mcp', inputs: [], url: 'https://mcp.desktopcommander.app/mcp', headers: [] },
  ],
}

export const BUILTIN_ENTRIES: DirectoryEntry[] = [REMOTE_DESKTOP_COMMANDER]
