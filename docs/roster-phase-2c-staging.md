# Phase 2C: Disposable Google Sheets staging adapter

This is a Node-only staging adapter and test, not a production Apps Script
handler or browser publishing route. It only accepts a workbook created by
the adapter in the same run. It does not accept an existing workbook ID,
use a production endpoint, copy production data, or use the Leave Portal.
The normal fixture and `rosterLiveEnabled = false` remain unchanged.

## Run an authorized staging test

1. Use a dedicated staging Google account or isolated staging project with
   the Sheets API enabled. Use an authorized short-lived OAuth access token
   with `https://www.googleapis.com/auth/spreadsheets`. Inject it locally as
   `ROSTER_STAGING_ACCESS_TOKEN` through your approved credential mechanism;
   do not paste or commit the token. Do not share the new book or enable
   scripts or triggers against it while testing.
2. Set `ROSTER_RUN_GOOGLE_STAGING=1` and run
   `node --test tests/roster-sheets-staging.test.cjs`. The opt-in test creates
   a new `DISPOSABLE ROSTER STAGING` workbook, seeds fake roster records,
   validates a generated monthly draft using the existing validator and
   fixture rules, publishes one batch and verifies the physical rows. It
   repeats the operation ID and verifies the stored rows contain no duplicate
   staff/date keys and preserve the seeded leave and out-of-scope records.
3. Review the workbook URL emitted by the test. Keep it for review or trash
   it manually when finished. Unset the two staging variables after the test.
   Do not copy its ID or data into deployment configuration.

Without opt-in, the live test is skipped. Three tests with a mock transport
still run, including an end-to-end monthly publish. They verify request shapes, duplicate and alias
checks, protected leave, stale before-images and read-back states. The test
journal is in-memory; it is not a durable production receipt or backup.
The staging test uses synthetic staff, shift and configuration inputs and
plain-text schedule times. It is not proof of deployed authorization,
concurrent-writer exclusion, or compatibility with production cell types.

## Production gates still required

- Obtain an authenticated export of the active Apps Script version and
  Worker revision, compare to the reviewed sources, then verify deployed
  trusted-edge behavior, signed Worker-to-Apps-Script requests, and authorized
  and denied staging reads. Owner-reported versions and local mocks do not
  establish these checks.
- Approve a durable operations journal and typed before-image store, plus an
  authoritative server-side source for the exact reviewed roster rules. Before
  wiring production, test atomic writes, conditional restoration and verified
  receipt recovery against those stores, along with schedule cache invalidation
  in the existing Staff Portal read paths.
- Designate a Super Admin verifier. Use the Leave Portal's existing pause and
  drain controls without changing that system. Verify the writer is idle
  and sees no unresolved operation; separately fence new Staff Portal schedule
  mutations and drain in-flight ones. Verify direct Sheet editors, triggers,
  integration accounts, and legacy deployments cannot write or move rows
  during publish and recovery. No browser acknowledgment or project-scoped
  Apps Script lock proves this; do not repurpose the attendance lock.
- If the Leave Portal's existing pause/drain and workbook permissions cannot
  enforce the window, keep production publishing disabled. Available
  alternatives are an owner-approved, technically enforced exclusive window
  using current operational controls, or deferring production until a separately
  approved coordination design is available. A read-only dry run is safe
  while the write gate is unresolved.

To roll back this staging work, stop the harness and trash only the clearly
identified disposable workbook after review. No changes are made to existing
workbooks, apps, Workers, Apps Script deployments, or legacy schedule routes.
