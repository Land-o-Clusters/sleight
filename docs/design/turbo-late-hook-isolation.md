# Turbo late-hook isolation for 1.6.1

Status: proposed. SA2C fixes hook freshness for 1.6.0. Secret isolation remains deferred to 1.6.1 (audit G4).

Handoff resume, popup adoption, reused unhooked named windows and existing same-site frames install the hook into documents that may already have run
page scripts. Those scripts can replace `Array.isArray`, `Uint8Array`, `Object.defineProperty` or `Object.freeze` before
installation and record the hook key or secret. A recorded secret could forge signed answers for its own tab or a
same-origin opener. The current registry shares credentials across tabs. This exposure has not been measured in Chromium.

SA2C marks every live installation as late. The signed `fresh` flag is false. The key-frame survey refuses trusted keys
and paste through that document. Clicks and other hook methods still trust signed answers from late hooks. Captured DOM
getters protect later reads from replacement. They do not prove that a late realm was pristine at installation.

The late-hook rule affects handoff-resumed and reattached tabs. It also affects unhooked popups and popups that the page
opens with a window name, including newly opened named popups. Turbo refuses Enter, Space and paste through those hooks.
A late hook may stay for that Window's lifetime, including its first navigation. An answering late hook refuses at the first
survey. An absent hook may still need the attachment timeout. If a late realm deleted the native `parent` getter before
installation, installing the hook throws and turbo reports a capability failure.

The isolated headless loopback test confirms that the registry's `about:blank` to HTTP navigation discards the initial
Window's marker, reports `fresh: true` and permits a key-frame arm. Handoff resume in the same test reports `fresh: false`
and refuses the arm. Input events sent on both routes: 0. HTTPS and popup listener ordering remain unmeasured.

For 1.6.1, give each independently adopted late tab its own `entry.hook`. A secret exposed there must authenticate no other
tab. An adopted popup whose first document already received its opener's install source must inherit that opener's hook
so the existing signed-verdict probe succeeds. Keep the hook installed on `about:blank` before navigation and the frame
filter's document-start script. Define how same-origin opener groups and resumed tabs separate before changing credentials.

Acceptance tests must replace each of the four intrinsics with recording wrappers before resume, capture dummy credentials,
and show that a forged signed `armed` answer fails in another tab. Include a same-origin popup under CSP without
`unsafe-eval`, already-hooked popup adoption, and the unchanged `about:blank` navigation route. An offline fixture can prove
controller isolation. A throwaway-profile loopback run must establish the browser's actual realm and listener behavior.
