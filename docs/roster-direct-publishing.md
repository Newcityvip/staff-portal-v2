# Direct roster publishing in Staff Portal V2

## Review status

This replaces the proposed OAuth/staging Sheets adapter route for deployment.
The earlier adapter remains unused in the repository and is not part of the
Apps Script deployment. The new roster-only action uses the existing
SpreadsheetApp connection and time normalization. Manual CSV upload,
single-shift update and all unrelated routes remain unchanged.

**Do not enable live publishing.** The checked-in window verifier always
denies. The existing leave pause/drain UI only proves the leave queue's
state, not absence of direct edits, independent triggers, older deployments,
or in-flight legacy schedule writes. No Sheet, Worker, deployment option,
role, property or browser checkbox in this commit overrides the denial.

## Local verification and backend files

- Run `node --test tests/roster-live.test.cjs tests/roster-publish.test.cjs`
  with Playwright and Chrome available. The Worker and Apps Script run
  against mocked services; the HTTPS-shaped browser test routes every
  request locally. Only the test harness replaces the verifier.
- Apps Script source files are `backend/Code.gs` (signed roster dispatch),
  `backend/RosterPublish.gs` (write, receipt and reconciliation), and
  `backend/RosterPublishValidator.gs` (generated validator). The validator
  uses the existing browser scheduling rules, with no copy of the policy
  to maintain independently. Rebuild the checked-in bundle using esbuild
  0.28.2 available to Node and `node scripts/build-roster-publish-validator.cjs`.
  Do not upload the JS entry point or the staging adapter as Apps Script files.
- The route updates only H:K on matching rows and appends full rows for
  approved new assignments. It does not reset formatting. Existing leave,
  dates before the team's current date, formulas on targeted schedule fields, duplicate identities, ambiguous
  login aliases and a changed preview all block writes as applicable.
- Script Properties hold one operation with capped before-images and
  a ten-minute minimum receipt retention. A pending or uncertain
  operation blocks new writes. The attendance script lock is held only
  for short journal transitions, never for sheet I/O. SpreadsheetApp can
  apply multiple ranges separately; this is not a transaction.
- Recovery reads affected rows by canonical ID/date without rewriting them.
  A mixed or unexpected outcome remains blocked for manual reconciliation.
  Keep the operation ID, receipt and before-images; never clear the journal
  to force a retry. Recovery after an Apps Script timeout is delayed until
  a pending execution can no longer be in flight.

## Deployment sequence after a separately approved write window

1. Verify the exact active Apps Script and Worker source against the reviewed
   baselines; verify edge/IP trust and signed roster authorization using the
   Phase 2A runbook. Confirm that the existing Apps Script URL and Worker
   target stay the same.
2. On an isolated staging copy using the existing Apps Script connection
   pattern, add both new Apps Script files and apply the roster dispatch
   diff to the verified Code.gs. Keep the Worker and Apps Script publish
   flags unset and `rosterPublishEnabled = false` until the verifier exists
   and is independently reviewed. Use only the corresponding reviewed
   Worker and roster frontend files. Do not replace unrelated scripts.
3. Approve the authoritative configuration per team and month, stored
   server-side under `ROSTER_PUBLISH_RULES_<UPPERCASE TEAM>_<YYYY-MM>` using
   the exact planning configuration fields (groups, memberships, rules,
   coverage, demand, preferences and transitions). Keep policy within Script
   Properties limits; no browser-written configuration is accepted.
4. Establish a verifiable window: demonstrate leave pause and drained status,
   fence and drain the legacy Staff Portal writers, and prevent all direct or
   external writes and row moves. The approved verifier must fail closed if
   any proof is missing or expired. No production enablement is possible
   from this commit alone. Validate staging formatting, cache refresh,
   authorization, partial failures and timeouts using that verifier.
5. Stop for owner approval before any production release. Once an approved
   verifier exists, deploy the compatible Apps Script and Worker first
   with publishing still off, verify original reads and legacy behavior,
   then enable the reviewed roster UI only for the approved window.

For rollback, keep schedule writers fenced if a commit is uncertain,
reconcile read-back and retain the journal, then disable publishing and
restore the previous frontend, Worker revision and Apps Script version on
the same deployment. Reverting code does not undo rows. Restore touched
cells only after matching their recorded after-images and obtaining approval.
