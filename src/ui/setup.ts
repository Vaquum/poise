// First-run setup (#556; docs/Service-architecture.md, "First-run setup"): a
// new workspace behind the gateway opens setup over the page, at pairing when
// Poise Link sent the person here; Settings → General runs it again.
import { restartOnboarding, startOnboarding } from './setup/onboarding'
import './setup/setup.css'

/** Opens setup when this workspace still needs it; true when it opened. */
export const startSetup = (place: string | null): Promise<boolean> => startOnboarding(place)

/** Settings → General → Run setup again: from its first step, with your choices prefilled. */
export function openSetup(_options: { again: true }): void {
  restartOnboarding().catch((error: unknown) => console.error('[setup] setup could not start again:', error))
}
