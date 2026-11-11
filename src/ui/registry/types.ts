// One registry entry: an element's name and the answers the reference gives
// about it (#556, the brief's universal reference). A function reads its answer
// from the live element; one that cannot answer returns ''.
export type RefText = string | ((el: HTMLElement) => string | undefined)

export interface RefEntry {
  name: string
  kind?: string
  what?: string
  short?: string
  tip?: RefText
  does?: RefText
  now?: RefText
  values?: [string, string][] | ((el: HTMLElement) => [string, string][])
  scope?: RefText
  when?: RefText
  unchanged?: RefText
  shows?: RefText
  source?: RefText
  unavailable?: RefText
}

export type Registry = Record<string, RefEntry>
