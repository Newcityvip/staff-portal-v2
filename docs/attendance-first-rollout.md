# Attendance-first rollout

Production starting point: GitHub Pages build of
`c5b7bf0d6c1bf5b8b277b07f37abeac43750b7e9` (November 25, 2026).
Record the currently active Apps Script version number in **Deploy > Manage
deployments** before doing anything; the GitHub Pages SHA does not identify it.

## Roll out after approval

1. Copy the reviewed branch's complete `backend/Code.gs` into the existing
   Apps Script project. Save. In **Deploy > Manage deployments**, edit the
   existing web-app deployment, select **New version**, and deploy. Keep the
   deployment ID, URL, execute-as identity, and access settings unchanged.
   Do not change the Worker, triggers, or Sheets.
2. Using authorized staff and both Super Admin and CSP Admin accounts on their
   normal allowed network, verify read-only requests through the existing
   Worker. Without a mode and with `dashboard_mode: "operations"`, confirm the
   old staff/admin response fields still exist. With
   `dashboard_mode: "attendance_first"`, confirm:
   - Staff: valid profile, allowed IP, timezone/date, applicable schedule,
     attendance state, and break counts; no monthly/upcoming/score/history
     arrays. Check a working shift and a leave or OFF day.
   - Admin: all eight summary counts and their details, break board, next-shift
     rows, and generated timestamp. Check CSP-only scope and absence of the
     removed reporting datasets.
   - History: `get_staff_attendance_history` returns only the signed-in staff
     member's events. Check both external dashboard links and read-only views.
   Do not copy credentials, sessions, or personal data into the review.
3. After authenticated checks and frontend approval, merge the reviewed draft
   PR and wait for the GitHub Pages build for the new main SHA. Sign in normally
   and check in browser Network that the staff login supplies the bootstrap
   and that navigation does not wait for another dashboard request. Refresh
   directly to check the fallback. Check last-updated, Retry, and mobile
   layouts. Do not submit test attendance or edit production Sheets.

Record login/IP/dashboard timing, TTFB versus transfer, response sizes, and
Apps Script execution time from authorized checks before making latency claims.
Local browser fixtures omit real Worker, Apps Script, and Sheets latency.

## Roll back if needed

1. Revert the frontend PR on `main` using GitHub's **Revert** action (or a
   revert PR for the merge/squash commit). Do not reset or force-push. Wait
   for Pages to publish the revert; reload and verify the legacy staff/admin
   interfaces and `operations` responses.
2. If the Apps Script release also needs rollback, edit the **same existing**
   deployment, select the previously recorded version, and deploy it. Keep
   its URL, access settings, Worker, and Sheets unchanged. Verify legacy
   dashboards and both external dashboards again. Roll back the frontend
   first where possible, because the new frontend expects the new read mode.
