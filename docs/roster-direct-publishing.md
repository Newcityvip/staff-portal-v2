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

1. Read-only owner checks: in Apps Script, use **Deploy > Manage deployments**
   to identify the active production version, then compare that version's
   source (not the editor's current draft) with the reviewed baseline. In
   Cloudflare **Workers & Pages**, inspect the active `staff-portal-api-v2`
   deployment and compare its source and upstream target. Confirm that the
   existing Apps Script URL is the target. Keep secrets out of logs and
   exports for review. A public GET/OPTIONS smoke test is not source or
   authenticated compatibility evidence. Verify edge/IP trust and signed
   roster authorization using the Phase 2A runbook.
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
4. Rehearse the shortest existing-controls window with a designated Super
   Admin. In Leave Management, use its existing **Pause** control, wait for
   the drain check, and refresh until the writer reports safe/idle and
   there are no unresolved in-flight writes. Queued jobs may remain; do not
   resume them during the window. This step needs no Leave Portal code,
   spreadsheet, or configuration changes.
5. Before any write window, verify an enforceable fence for **both** Staff
   Portal schedule actions at Apps Script ingress, including the direct
   web-app route, and drain requests admitted before the fence. Neither
   legacy route is fenced by this commit. Inventory editors, owner-run
   scripts/triggers, other deployments, and service accounts that can write
   or move rows. Exclude or stop them for the entire window. A sheet
   protection rule, screenshot, or instruction to stop editing is not
   proof that owner-executed scripts cannot write. Keep attendance and
   other routes available. The verifier must deny if any of this proof is
   missing or expired. If the owner cannot prove these conditions using
   existing controls, no live write window is available.
6. Stop for owner approval before a production release. The shortest
   independently releasable step is read-only: update the reviewed Apps
   Script files on the **same** deployment URL, then the matching Worker
   targeting that URL, with publishing disabled. Verify existing reads,
   legacy behavior, authorized roster reads and rejected cross-team reads.
   Then release the reviewed Pages frontend and verify **Admin Dashboard >
   Monthly Roster Builder**. The dashboard session exposes only the link;
   the roster sign-in and server checks enforce Super Admin and CSP roles.
7. Publish enablement is a separate release after a verifier and legacy
   ingress fence are approved. In isolated staging, validate formatting,
   cache refresh, authorization, read-back, partial failures and timeouts,
   and prove that the window fails closed. Deploy with publishing off;
   enable only within a verified window after explicit approval. Verify
   the receipt before reopening legacy writers, restoring direct editing,
   and resuming the leave queue. No production enablement is possible from
   this commit alone.

For rollback, withdraw publish access from the UI and keep schedule writers
fenced if a commit is uncertain. Retain the receipt and reconcile the
original operation before trying another mutation or disabling the recovery
endpoint. Restore the previous Pages release, Worker revision, and Apps
Script version on the same deployment URL, then smoke-test legacy routes
before resuming writers. Reverting code does not undo rows. Restore touched
cells only after matching their recorded after-images and obtaining approval.
