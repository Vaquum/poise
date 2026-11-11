// A place not built yet (#556 PRs 2 to 4 replace this, one place at a time).
import { PLACE_NAMES } from '../address'
import { routeBack } from '../shell'
import type { MountPlace } from '../router'

export const mount: MountPlace = ({ address, root }) => {
  root.innerHTML = `<main class="placeholder" data-placeholder><a class="back" href="#" data-back hidden data-ref="back"></a><h1 class="t-display">${PLACE_NAMES[address.place]}</h1><p class="t-gloss">This place is not built yet. Classic Poise has it at <a class="lnk" href="/">/</a>.</p></main>`
  routeBack(root.querySelector('[data-back]'), address)
}
