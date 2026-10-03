// What a Connect terminal runs in a test: the preset's own login, but only
// once the CLI it starts resolves to its fake in `bin` on the PATH the preset
// runs with. Otherwise it throws before any process starts, and the terminal
// closes with the reason. Claude's preset starts Poise's wrapper, which starts
// `claude` from that same PATH, so it is `claude` that must be the fake.

import { presetCommand } from '../../../server/terminal/presets'
import type { TerminalCommand } from '../../../server/terminal/pty'
import type { TerminalPreset } from '../../../server/terminal/protocol'
import { COMMANDS, assertFake } from './fake-clis'

export function fakePresetCommand(bin: string): (preset: TerminalPreset) => TerminalCommand {
  return (preset) => {
    if (preset === 'shell') throw new Error('a test may not open the login shell: it has no fake')
    const command = presetCommand(preset)
    assertFake(bin, COMMANDS[preset], command.env.PATH ?? '')
    return command
  }
}
