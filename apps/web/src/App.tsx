import { useState } from 'react'
import { INK, RULE } from './components/Bits.tsx'
import PolicyScreen from './screens/PolicyScreen.tsx'
import ProofScreen from './screens/ProofScreen.tsx'
import SensorScreen from './screens/SensorScreen.tsx'

/**
 * The M0 prototype — three screens on mock numbers, no chain, no backend.
 *
 * One `useState` instead of a router: three views do not need one, and the
 * point of the entry point here is that all three are reachable by tapping.
 * A screen that exists in the tree but cannot be reached does not exist.
 */

type View = 'policy' | 'sensor' | 'proof'

const TABS: ReadonlyArray<{ id: View; label: string }> = [
  { id: 'policy', label: 'My policy' },
  { id: 'sensor', label: 'My sensor' },
  { id: 'proof', label: 'Why it paid' },
]

/**
 * `?view=sensor` opens on that screen — the landing's door for operators, the
 * way `?policy=` is the farmer's. Anything else, including no parameter, is the
 * policy screen: a link that names a screen we do not have still lands somewhere.
 */
export function initialView(search: string): View {
  const asked = new URLSearchParams(search).get('view')
  return TABS.find((tab) => tab.id === asked)?.id ?? 'policy'
}

/**
 * One column, never panels side by side — but not a phone frame on a desktop.
 * M0 held the column at phone width everywhere; on a wide screen that read as
 * a phone emulator. 720 px is the landing's text column, so going from the
 * landing into the app does not change the measure. On a phone the column is
 * the screen, as before.
 */
const COLUMN = 720

export function App() {
  const [view, setView] = useState<View>(() => initialView(window.location.search))

  return (
    <div style={{ minHeight: '100vh', background: '#FBFAF7', color: INK }}>
      <div style={{ width: '100%', maxWidth: COLUMN, margin: '0 auto', padding: '0 20px 64px' }}>
        <header style={{ paddingTop: 26 }}>
          <div
            style={{
              fontSize: 17,
              fontWeight: 700,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
            }}
          >
            Pumpking
          </div>
          <div style={{ marginTop: 4, fontSize: 15 }}>Drought cover, 29 August 2026</div>

          <nav style={{ display: 'flex', gap: 0, marginTop: 20, marginBottom: 26 }}>
            {TABS.map((tab) => {
              const active = tab.id === view
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setView(tab.id)}
                  style={{
                    flex: 1,
                    background: 'transparent',
                    border: 'none',
                    borderBottom: `2px solid ${active ? INK : RULE}`,
                    padding: '10px 0',
                    fontSize: 15,
                    fontWeight: active ? 700 : 400,
                    color: INK,
                    cursor: 'pointer',
                    textAlign: 'center',
                  }}
                >
                  {tab.label}
                </button>
              )
            })}
          </nav>
        </header>

        <main>
          {view === 'policy' ? <PolicyScreen /> : null}
          {view === 'sensor' ? <SensorScreen /> : null}
          {view === 'proof' ? <ProofScreen /> : null}
        </main>
      </div>
    </div>
  )
}
