# Phase 2 release checks

Production frontend investigated: `ea513ae283caaf365b2ac023d26f9ca105fa9e17`.
The active Apps Script version number is not visible from GitHub or a public
Worker response. Record it in **Deploy > Manage deployments** before any
backend rollout. Do not change the deployment URL, Worker, or Sheets.

## Production evidence still needed

- **History:** With a normal staff session on an allowed network, open
  DevTools > Network and click **Load History** once. Record the action name,
  HTTP status, whether the response has `ok` and an `attendance_events`
  array, the array length, response size, and timing (connection, waiting,
  transfer). For failures record the error category and compare with the
  corresponding Apps Script execution for `get_staff_attendance_history`.
  Do not share login IDs, IPs, response rows, session headers, or a full HAR.
  The initial anonymous probe only established that the route was recognized
  and rejected an unauthenticated request; it did not establish the cause of
  failures for authorized staff.
- **Staff login:** Capture an ordinary sign-in. Record IP-discovery request
  count and timing, `staff_login` time and size, and whether its JSON
  contains `attendance_bootstrap` with `ok`, matching identity and IP, date,
  timezone, and attendance/schedule keys. Record only presence/equality checks,
  not the values. Compare the response timestamp with the browser clock.
  Confirm no `get_staff_dashboard` blocks readiness when the snapshot is
  valid. Reload separately and confirm one minimal dashboard read. In
  Apps Script Executions, compare login handler duration with the browser
  waiting time. Browser timing alone does not isolate Worker forwarding,
  Apps Script execution, or Sheets I/O.
- **Admin:** Check a Super Admin and CSP Admin session. Compare response
  time, size, and execution duration. Confirm that a transient failure leaves
  the last data and timestamp visible, and only a successful dashboard read
  restores Live. Verify CSP results remain within the existing team scope.
- **History authorization:** Verify the returned records belong to the
  signed-in account using normal sessions only. This release preserves the
  existing IP and active-staff login checks; it does not introduce an
  independent server-side session proof or change staff authentication.

## Deploy or roll back after approval

1. Save the exact currently active Apps Script version number. After reviewing
   the approved branch, deploy its complete `backend/Code.gs` as a new version
   of the same existing web app. Keep execute-as and access settings unchanged.
2. Verify legacy and attendance-first reads through the existing Worker with
   authorized users. Then merge only after frontend approval, wait for the
   GitHub Pages build, and repeat the checks. Verify the cyan favicon on
   login, staff, and admin pages under `/staff-portal-v2/`.
3. If rollback is needed, revert only the Phase 2 PR and wait for Pages to
   publish that revert. If the backend also needs rollback, select the
   recorded previous version on the same deployment. Do not use a reset,
   change the Worker, edit Sheets, or generate test attendance events.
