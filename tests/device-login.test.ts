import { describe, expect, it } from 'vitest'
import { plainText, readDeviceLogin } from '../src/views/device-login'

// What gh 2.92's `auth login --web` prints in a workspace terminal, colours
// included: its git question, the code it failed to copy to a clipboard, its
// Enter prompt, and the browser it could not open.
const QUESTION = '\u001b[0;32m?\u001b[0m \u001b[0;1;39mAuthenticate Git with your GitHub credentials? \u001b[0m(Y/n) '
const ANSWERED = '\r\u001b[2K\u001b[0;32m?\u001b[0m \u001b[0;1;39mAuthenticate Git with your GitHub credentials? \u001b[0m\u001b[0;36mYes\u001b[0m\r\n'
const CODE = '\r\n\u001b[0;33m!\u001b[0m Failed to copy one-time code to clipboard\r\n  No clipboard utilities available. Please install xsel, xclip, wl-clipboard or Termux:API add-on for termux-clipboard-get/set.\r\n'
  + '\u001b[0;33m!\u001b[0m First copy your one-time code: \u001b[0;1;39m0281-B27E\u001b[0m\r\n'
const ENTER = '\u001b[0;1;39mPress Enter\u001b[0m to open https://github.com/login/device in your browser... '
const BROWSER = '\r\n\u001b[0;31m!\u001b[0m Failed opening a web browser at https://github.com/login/device\r\n  exec: "xdg-open,x-www-browser,www-browser,wslview": executable file not found in $PATH\r\n  Please try entering the URL in your browser manually\r\n'

describe('reading gh\'s device sign-in', () => {
  it('finds nothing to answer before gh asks', () => {
    expect(readDeviceLogin('')).toEqual({ code: null, askedGit: false, askedEnter: false })
  })

  it('sees the git question, then the code and the Enter prompt, through gh\'s colours', () => {
    expect(readDeviceLogin(QUESTION)).toEqual({ code: null, askedGit: true, askedEnter: false })
    expect(readDeviceLogin(QUESTION + ANSWERED + CODE)).toEqual({ code: '0281-B27E', askedGit: true, askedEnter: false })
    expect(readDeviceLogin(QUESTION + ANSWERED + CODE + ENTER + BROWSER)).toEqual({ code: '0281-B27E', askedGit: true, askedEnter: true })
  })

  it('takes no other eight characters for the code', () => {
    expect(readDeviceLogin('Visit https://github.com/login/device and use ABCD-1234 later\r\n').code).toBeNull()
    expect(readDeviceLogin('! First copy your one-time code: ABCD-12345\r\n').code).toBeNull()
  })

  it('shows gh\'s output as plain text', () => {
    const text = plainText(QUESTION + ANSWERED + CODE + ENTER + BROWSER)
    expect(text).not.toMatch(/\u001b/)
    expect(text).toContain('! First copy your one-time code: 0281-B27E\n')
    expect(text).toContain('Please try entering the URL in your browser manually\n')
  })
})
