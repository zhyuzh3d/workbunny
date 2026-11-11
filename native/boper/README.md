# BOPER native boundary

Build using `zsh tools/build-boper.sh`. Outputs are arm64, deployment target
macOS 13: `build/native/boper-runtime`, `boper-hid-helper`,
`boper-control.node`, and the build provenance manifest.

The app bundles runtime/addon under `Contents/Resources/bin` and the helper
under `Contents/Library/LaunchServices`. An explicit local administrator install
copies the helper to `/Library/PrivilegedHelperTools/cn.haminn.workbunny.boper-hid`
and `cn.haminn.workbunny.boper-hid.root.plist` to
`/Library/LaunchDaemons/cn.haminn.workbunny.boper-hid.plist`. Both installed files
are root:wheel, regular non-symlink files without group/other write permissions.
The source SMAppService plist is retained only for legacy migration. Signing
identifiers are fixed by the build policy: `cn.haminn.workbunny`, `.boper-runtime`, and `.boper-hid`. The build
pins a certificate SHA1 from `WORKBUNNY_BOPER_CERT_SHA1`, or the local
`WORKBUNNY_SIGN_IDENTITY` certificate. Ad-hoc authentication is rejected.

## Ordinary process protocol

Private inherited stdin/stdout JSONL; fd 3 is an independent host-to-runtime
control pipe. Maximum line size 256 KiB. No public socket exists. Replies are
`{id,ok,result}` or `{id,ok:false,error:{code,message},result?}`. Bodies and
clipboard contents are not logged or returned.

- `status` reports actual session state and capabilities.
- `beginSession` requires `inputSessionId`, explicit `backend` (`cg-event` or
  `virtual-hid`), `leaseMs` (250..3000), and nonempty observed `displayBounds`.
  Virtual mode additionally requires the host addon's `delegationToken`.
- `execute` requires that session, `operationId`, and `operation:{action,params}`.
  One Operation is admitted; concurrent operations receive `E_BUSY`.
- `renewSession` renews only an unexpired native session. For VirtualHID the
  host separately renews helper authority through the addon. The worker cannot
  renew its own privileged authority.
- `stop`/`closeSession` invalidate first, then release on the same ordered output
  queue. fd 3 accepts only status, renewal and stop/close. EOF invalidates input.

Operations are `move`, `click`, `mouseDown`, `mouseUp`, `drag`, `scroll`, `key`,
`keyDown`, `keyUp`, and `typeText`. Coordinates are desktop logical points.
`key` is a physical ANSI key name plus modifier names. Text uses write-only
plain-text clipboard preparation and a physical Cmd+V sequence in the selected
backend; no old clipboard content is read or restored. Key requests may carry
`clipboardChangeCount` for an already prepared authorized file clipboard.
VirtualHID rejects all `targetPid` input before side effects; targeted text is
also unsupported in this initial CG adapter and requests foreground recovery.

An operation can include `params.visualEvidence.capturedAt` in epoch
milliseconds. Down/key/paste commits require evidence age at most 1500ms after
movement. Expiry retains the partial movement receipt and does not click.

Receipts distinguish `reportsAttempted`, `reportsSubmitted`,
`dispatchOutcomeUnknown`, `clipboardChanged`, and `moved`. A timed-out helper
call may already have dispatched; it must never be retried based on a zero ACK
count. `releaseConfirmed` has the explicitly reported `releaseLevel` only:
CGEvent local submission or virtual daemon receipt, never target verification.

## Host addon

Promise APIs: `status()`, `refresh()`, `register()`,
`unregisterLegacyService()` (`unregister()` compatibility alias), `openSettings()`,
`authorizeRuntime({pid,inputSessionId,leaseMs})`,
`renewSession({inputSessionId,leaseMs})`, and
`revokeSession({inputSessionId})`, and explicit `recover()`. Authorization returns a one-use random
`delegationToken`, delivered to the exact worker PID through the inherited
pipe. It is never placed on argv, the environment or a public file.

Management requires the real sealed signed app and rejects script/debug launch
flags. The application must also disable Electron's RunAsNode, NODE_OPTIONS and
CLI inspection fuses. XPC control/input services have separate exact code
requirements; same-team membership alone is insufficient. Helper validation
binds UID, login audit session, worker PID, token and live host connection.
App resource checks are cached per process/connection outside the renewal path.

`status()` and `refresh()` inspect only the fixed administrator-installed root
files, their ownership/permissions, exact locally pinned helper signature and
CodeDirectory hash. They expose `helperRequirement` as the fixed compiled
identifier/certificate requirement, `installedHelperCDHash`,
`bundledHelperCDHash`, and `updateRequired`. CodeDirectory comparison avoids
upgrades caused only by a new signing timestamp. Missing components return
`installed: false, state: "install-required"`; a different helper returns
`state: "update-required"`. Only a matching installed helper is contacted.
`helperConnected: true` / `serviceStatus: "enabled"` require a real authenticated
reply; installed files alone report `serviceStatus: "installed"`. Device
`ready` still requires both keyboard and pointing readiness.

`register()` is now only an authenticated health probe. It never registers an
SMAppService job, invokes sudo, installs a file or runs a privileged command.
The separate application installer performs a fixed, verified installation
script after the user grants normal local administrator authorization. It must
verify the source manifest/bytes and compiled signing requirement, atomically
install only these own root files, then bootstrap their standard launchd job.

`unregisterLegacyService()` is only for migration of the old bundled
SMAppService job, and awaits its completion with an eight-second bound. It must
run before the administrator bootstraps the new fixed root job with the same
label. It is not an uninstall operation for the root-owned service. Explicit
user disable stops the input session; removing the root files is a separate
administrator operation. Helper RPC failures and timeouts invalidate exactly
the old connection, never a newer connection or the shared Karabiner daemon.

This local-admin route follows the already running keymouse installation's
standard root-owned launchd boundary, while retaining authenticated XPC instead
of its public unauthenticated socket. The prior SMAppService-managed route was
observed failing a generated AMFI spawn constraint with a local signing chain;
that observation does not imply all administrator-installed launchd jobs need
an Apple account. The new route changes neither AMFI/Gatekeeper settings nor
certificate root trust, and makes no claim that disk verification alone proves
real daemon acceptance. Local installation and actual input still require
real-system acceptance.

The helper is demand-launched by its Mach services. After the last host that
actually sent an authenticated control message disconnects, it invalidates the
old session and, once no authority transition is active, releases only its own
devices on the ordered output queue and exits. A new host arriving before exit
is committed cancels the idle exit. Unauthenticated connections and live status
polling do not cause a restart loop. The independent exit bound is 1.5 seconds;
if daemon receipt cannot be obtained, process disconnect still lets the daemon
tear down this client's devices, without claiming confirmed release.

The root helper accepts finite full-state keyboard/pointing reports, status,
authorization and reset only. One outstanding report, sequence numbers,
continuous-time report deadlines and a host-only lease bound its queue. Its
independent watchdog samples console session metadata at 40ms, invalidates on
sleep/lock/logout/session change, and queues zero state after invalidation.
Console metadata uses `IOConsoleUsers`; its key availability remains a
cross-version acceptance item. No target app interfaces or input contents are
observed.

After a latched output fault, the host first stops and reaps its old executor,
then explicitly calls `recover()`. Recovery requires the sealed authenticated
host in the unlocked console session, no active owner or transition, connected
transport and both compatible devices. It reserves an invalidating epoch,
orders empty reports on this client's own two devices, and clears the fault only
after both daemon receipts and a final epoch/readiness/session check. It never
restarts the shared daemon, resets another client's devices, or replays an old
Operation. The host retains unknown business effects in its existing ledger.

## Validation and limits

The build runs safe key-map/trajectory/envelope selftests and pipe/control
negative tests. These submit no input. Runtime motion uses minimum-jerk timing
and bounded pulse/settle feedback; relative gain is measured from matching raw
and settled pointer intervals. Movement stops after four seconds or 45 final
corrections. It does not learn gain from endpoint displacement divided by
total curved path length, replay stale samples, or manufacture typing mistakes.

The runtime's offline lifecycle regression uses an in-memory NSObject transport,
not an NSXPC connection or input backend. It confirms that visual expiry and
release can be followed by a new session, synchronous retirement and late
callbacks from the old connection cannot cancel the new session, old close and
renew requests are rejected, and a matching stop during opening still prevents
activation. The offline constructor skips CG callbacks, permission queries and
the watchdog, and every fake report count must remain zero. Production JSONL
has no test-backend selector. Connection retirement, callback identity checks,
session matching and cancellation are serialized under the state mutex; the
1500ms visual commit guard remains unchanged.

Compilation and selftests do not establish a successful administrator root-job
installation, driver compatibility, actual paste contents, accurate movement,
cross-version support or reliable automatic human takeover. Those require the
supervised local receiver and system acceptance described in the development
plan. Automatic physical takeover is explicitly reported unsupported; the
initial implementation therefore requires supervised handoff. No WeChat
testing is part of these native selftests.
