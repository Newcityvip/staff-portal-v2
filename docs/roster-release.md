# Monthly Roster Builder release

Stop for owner approval before any deployment. No production writes are part
of Stage 1. Production GitHub Pages origin: `https://newcityvip.github.io`.
The roster entry uses the existing Admin Dashboard and requires its own
server-verified roster sign-in. Local previews do not use the live Worker.

## Stage 1: read-only release

1. Record the currently published GitHub Pages commit, the precise active
   Apps Script version and existing deployment URL, and the Cloudflare Worker
   production revision and upstream URL. Compare the active sources against
   the reviewed baseline before replacing them. If they differ, stop and
   reconcile the source. A public health check does not prove their identity.
2. In the **existing Staff Portal Apps Script project**, apply the reviewed
   additions in `backend/Code.gs` and add `backend/RosterPublish.gs` and
   `backend/RosterPublishValidator.gs` as script files. Do not replace other
   project files or change the manifest, execution identity, or access mode.
   The validator is already built. Do not upload the superseded Sheets
   staging adapter or any Node source.
3. In Apps Script **Project Settings > Script properties**, configure
   `ROSTER_BRIDGE_KEY` and `ROSTER_SESSION_KEY` as different random 32-byte
   values encoded as 64 hex characters. Keep the session key in Apps Script
   only. Configure `ROSTER_TEAM_SHIFT_CODES` with the confirmed active codes
   for both Affiliate and CSP, and optional `ROSTER_EXCLUDED_STAFF_IDS`.
   Check the allowlist and the Staff Master, shift and schedule headers on
   both teams. Do not guess the active-code lists or change Sheet data to
   make them fit. Leave `ROSTER_PUBLISH_ENABLED` unset. Keep
   `ROSTER_ENABLED` off until the signed read-only check can be performed.
4. Use **Deploy > Manage deployments > Edit** to create a new version of the
   **existing** deployment, retaining its URL. After approval, in Cloudflare
   **Workers & Pages > staff-portal-api-v2**, prepare the ES-module Worker
   from `worker/staff-portal-api-v2.mjs`. Configure `GAS_URL` to the exact
   prior Apps Script URL before activating this revision; the reviewed
   Worker uses that binding for legacy traffic as well. Set `ROSTER_ORIGIN`
   to `https://newcityvip.github.io` with no path or trailing slash, and
   set `ROSTER_BRIDGE_KEY` as the matching Worker secret. Preserve other
   bindings. Leave `ROSTER_PUBLISH_ENABLED` unset. Verify direct edge ingress
   and that untrusted Worker subrequests cannot reach the roster signer as
   direct browsers. Activate the reviewed Worker, verify legacy GET and
   preflight, and set `ROSTER_ENABLED=1` on both sides only for the approved
   signed read-only checks. Never put the shared key in frontend files.
5. Before GitHub Pages rollout, use approved Super Admin and CSP Admin test
   sessions. Verify signed roster snapshot reads for both teams with Super
   Admin, CSP-only access for CSP Admin, denied requests from a disallowed
   network or origin, overnight times and leave, and denial of the publish
   route. Do not submit attendance, break or schedule writes as smoke tests.
   If an authorized browser test needs a staging frontend, serve a reviewed
   copy under its separately approved origin and point only that copy at
   the corresponding staging Worker; do not reuse production secrets.
6. After the checks and explicit merge approval, merge PR #8 and verify the
   GitHub Pages deploy. The candidate frontend enables roster **reads** only
   on the production origin, leaves publishing off, and links from the Admin
   Dashboard. Verify sign-in, scoped source data, local drafting, validation
   and CSV/Excel export. The existing CSV upload remains available with its
   approved manual leave reminder. Do not use it for a test upload.

## Stage 2: proposed write window, not implemented

Use the existing Apps Script project and the existing roster authorization.
Protect only CSV upload, single-shift update, and monthly publish. This is
not permission to enable publishing in Stage 1.

1. Add a small admission guard around the two legacy writer dispatch cases
   in `Code.gs`, not inside their business logic. Under a short ScriptLock,
   atomically reserve an execution ID while in `NORMAL`; release the lock
   before calling the original function. Clear that ID in `finally`. A
   busy guard returns the original error envelope without starting a write.
   Enforce this on the Apps Script origin, including direct calls, not only
   in Cloudflare. Any trigger that invokes those functions directly must be
   fenced separately or routed through the same guard. Attendance and other
   actions never enter this admission flow.
2. Expose the guard's status and transitions only to verified Super Admins
   on the signed roster route. Store `NORMAL`, `DRAINING`, or
   `EXCLUSIVE`, the in-flight execution IDs and one expiring team/month
   window in Script Properties. Entering `DRAINING` rejects new legacy
   writes. An empty in-flight list is required before `EXCLUSIVE`. A
   crashed execution retains its reservation until an owner verifies its
   termination in Apps Script Executions; do not simply clear it on timeout.
3. Manual owner step: pause the independent leave writer using its existing
   controls. Refresh until the writer reports safe/idle and there is no
   unresolved operation. Keep it paused. Inventory write principals for
   **Schedule Master**, including direct editors, triggers, service accounts,
   and old web-app deployments. Temporarily restrict editing on the main
   Schedule Master for principals that can be excluded by permissions;
   stop independently scheduled or owner-run writers and verify that no
   other authorized operator can restart them during the window. Leave
   Management code, configuration, spreadsheet, and mirror stay unchanged.
4. Replace the deny-only verifier only when enforcement is demonstrated.
   It must require the fenced/drained Staff Portal state, the scoped
   unexpired window, and trustworthy evidence that the external writer
   remains excluded. Prefer a write denial enforced on the main workbook
   for an identified distinct external principal, or an existing control
   that can prove the paused state cannot be bypassed. If the two scripts
   share the owner's edit identity or the leave pause can be bypassed or
   resumed, a sheet protection rule or a manual attestation is not enough.
   Keep publishing off until that case has a verified solution.
5. Run an isolated mixed-writer rehearsal and validate read-back, failure
   and recovery. During an approved real window, authorize only the selected
   team/month; check the window again just before mutation. Closing or
   expiring a window stops new publishes but must not automatically reopen
   writers while a receipt is unresolved. Once the verified receipt or
   reconciliation is complete, restore editor permissions, return the
   Staff Portal guard to `NORMAL`, and resume the existing leave queue.

## Rollback

- Stage 1: disable roster reads on the Worker and Apps Script, restore the
  prior Pages release and Worker revision, and select the recorded Apps
  Script version on the same deployment. Verify legacy dashboard reads
  and CORS. No Sheet rows need rollback.
- Stage 2: stop new publish attempts but keep the writer fence and recovery
  path available until the original operation is reconciled. Preserve the
  receipt and before-images. Restore versions only after determining the
  actual write outcome. Code rollback does not restore data; repair touched
  cells only by approved conditional recovery, never a blanket revert.
