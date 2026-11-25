# Verified Staff Leave integration

Install `verified-leave.gs` with the reviewed `Code.gs` in the same bound Apps Script project. Include the updated import function if the optional admin upgrade is installed. The existing roster upload and single-date editor share the new action's script lock. Use the Advanced Google Sheets service v4 for atomic roster changes and the operation receipt. A managed Google Cloud project may also require the Sheets API to be enabled.

The server-only POST action `apply_verified_leave` requires `LEAVE_WRITE_ENABLED=true`, an exact `LEAVE_WRITE_TEAM`, and an independent 64-hex-character `LEAVE_WRITE_TOKEN` in Script Properties. Keep credentials in server configuration. The V1 Worker posts the token in the JSON body over HTTPS. Read requests to the standalone mirror continue to use its separate read credential.

Test in a copy first. A successful reply means the source reread every requested employee/date, confirmed the requested H/K codes and empty I/J, and recognized the decision receipt. V1 verifies its mirror separately. Keep receipt metadata for the lifetime of the leave record. Sheets rejects a duplicate metadata ID atomically, including the associated cell writes. Quota or receipt ID conflicts require operator investigation.

A script lock coordinates writers in this project. A live pilot requires an approved employee/date and a window without direct sheet edits, sorting, or external imports that bypass this lock. Existing OFF or historical leave rows and stale working revisions cause the entire write to stop. No automatic reversal is provided.
