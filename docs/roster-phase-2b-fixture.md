# Phase 2B direct publishing fixture

This is a loopback-only simulation. It does not connect to Sheets, the
production Worker, or Apps Script. A restart clears fixture schedule data,
receipts and before-images. The Node service and in-memory fixture adapter
are review code, not an Apps Script deployment artifact.

## Manual acceptance

Run `node scripts/roster-preview.cjs --publish-fixture 8772`. Open
`http://127.0.0.1:8772/admin-roster-source.html?publish=fixture&team=Affiliate&month=2026-12`.
The fixture signs in automatically as Super Admin. Start with the full
eligible directory and the fixture's server-approved default configuration.

1. Open Published Copy, Run the generator, and Apply candidate.
2. Select Preview, Review confirmation, then Review simulated publish.
3. Review new, updated, unchanged and conflicting counts and expand changed
   rows. Confirm Publish Final Schedule is unavailable until the manual
   Future_Leave_Requests acknowledgment is checked.
4. Publish once; wait for the simulated read-back receipt. Use Check
   Operation Status to retrieve the same outcome. Return via Review source
   and inspect the mock rows, including protected leave and adjacent months.
5. To test a server-side rejection, change draft coverage or rules to diverge
   from the approved fixture configuration, generate a valid local candidate,
   then attempt Review simulated publish. It must not write.
6. Other loopback instances accept `closed`, `interrupt-before`,
   `interrupt-after`, or `mismatch` as the third CLI argument after the port.
   With an interrupted write, check operation status before using Reconcile
   Uncertain Write. Before-batch failure reconciles as not written; an
   after-batch failure becomes verified only after read-back. A mismatch
   remains blocked. Do not change or clear a receipt to force a retry.

## Preconditions for a real adapter

- Confirm the Phase 2A deployed source, trusted ingress and authorized
  staging gates. Authenticate and authorize through the roster bridge; never
  accept the browser's role, identity, team claims or window status as proof.
- Designate a Super Admin as window verifier. Verify the leave queue has been
  paused and the independent writer has reported idle, with no unresolved
  dispatch. Block and drain both Staff Portal schedule mutations and verify
  that direct editors, older deployments, triggers, service accounts and
  integrations cannot write during the window. Do not hold the attendance
  lock through the write. A checkbox, operational attestation, or Apps
  Script lock alone cannot establish exclusivity.
- Approve an authoritative server-side store for the reviewed roster
  configuration, including groups, coverage and effective staff rules. The
  fixture validates with the existing roster validator against the
  independently generated fixture configuration; it will not accept a
  browser-authored configuration as authoritative.
- Approve a durable production operation journal and typed before-image store,
  outside Schedule Master. Use a single verified Sheets atomic batch with
  the existing schedule schema and time formats, reject oversized batches,
  verify physical rows and their identities, and invalidate the Staff Portal
  schedule cache only after successful read-back. The fixture does not
  validate real Sheet formatting, row permissions or timeout behavior.

No live action is wired in the Apps Script router or Worker. No Phase 2A
security controls or legacy schedule writer code were changed. To roll back
the simulation, stop the local preview and discard its fixture state. For a
future adapter, keep writers paused if an outcome is uncertain; restore
only touched rows whose values still match recorded after-images, verify
read-back, then reopen the window to existing writers.
