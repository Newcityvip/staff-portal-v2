# Shared production roster writer

## Activation prerequisites

Inventory the deployed Apps Script sources, triggers, older executable deployment URLs, workbook sharing (including groups), service accounts, API clients and imports. The repository contains three roster mutations: uploadScheduleCsv, updateSingleStaffSchedule and the optional importSchedule (import_schedule/upload_schedule). Apply the guard to every installed copy or alias. Preserve any deployment-only handlers. An older URL that can still edit the roster bypasses coordination. Keep the independent pilot writer disabled.

Restrict actual editing of the whole 04_Schedule_Master sheet to the V2 execution identity. Use restricted editors, including row insertion, deletion and sorting. A warning-only range is insufficient. Protect the append-only 11_Audit_Log likewise, preserving legitimate V2 logging. Ordinary staff and editors use the existing portal. Spreadsheet owners and any automation running as an allowed identity can still bypass protection. Retire or route those writers through this code. If exclusive routing cannot be established, keep the leave writer off.

Confirm V2 can open the intended workbook using its existing ss() helper, the Sheets advanced service v4 is enabled in this project, the reserved spreadsheet metadata ID 1743905601 is available, and the audit columns F/G/H/J are action/module/target_id/new_value respectively. Validate metadata create/search/delete and roster/audit batch permissions on an isolated copy first. Keep the same Apps Script/Cloud project for access to project-visible mutex metadata. Compare the install against the active version, save its version and recoverable backups before changing it. Preserve existing triggers, services, settings and URL.

## Operation

The three ordinary writers and the two authenticated leave actions acquire the same spreadsheet-scoped unique metadata ID before looking up any roster row. The owner deletes only its own lock after flushing writes. Attendance and breaks do not contend for it. Normal operations need no activation window. A new leave dispatch validates every requested working row against its original revision, then issues one atomic Sheets batch covering H:K and an append to the existing audit log. The receipt holds the decision ID, payload digest and protected employee dates. Routine imports skip those dates; the single editor returns an actionable error. The existing completed pilot has a narrow historical guard. Leave accounting and original shift snapshots stay in Leave Management D1.

The audit append follows the existing 12-column layout. Neither tokens nor complete request payloads belong in audit notes. Keep audit rows append-only and include them in backups. The receipt scan reads audit columns F:J. Monitor latency, quotas and cron backlog as the log grows. Changes to protected records require exceptional audited reconciliation. A reversal does not restore working hours automatically. Preserve decision history and require a reviewed restoration and protection-release plan before processing such an exception.

## Deployment after approval

1. Confirm the prerequisites, inspect D1 for other already synchronized active decisions lacking protections, and resolve any discrepancies without replay. Preserve the completed pilot.
2. Add the roster-coordination and verified-roster files and the scoped handler changes to the existing V2 project. Apply the optional importSchedule edits only where that helper is installed. Preserve the deployed Apps Script manifest, enabling the Sheets service if required. Set LEAVE_WRITE_ENABLED=false and configure a distinct random 64-hex LEAVE_WRITE_TOKEN server-side. Use a new version on the same deployment URL.
3. Complete the Leave Management deployment steps in its SHARED-ROSTER.md. Enable the V2 switch only after coordinated rollout approval. For ordinary approvals the scheduled Worker verifies both the source receipt and the mirror. Stored shift snapshots and the original decision ID are the reconciliation keys.

## Recovery and rollback

Disable new leave dispatch and drain any in-flight operations before changing versions. Keep the coordinated import and edit guards active while protected decisions exist. Hold roster mutations before reverting to an older unguarded V2 backend. Leave other V2 functions available. Restore the prior Leave Management version with its writer disabled. Retain D1, receipts, backups and the disabled pilot configuration.

If a mutex survives a terminated execution or uncertain write, first stop roster writers, confirm all prior Apps Script executions and pending Sheets requests have settled, then compare the affected rows, audit receipt, D1 dispatch evidence and original snapshot. If settlement cannot be established, keep the gate closed. After reconciliation, an authorized maintainer may remove only the observed gate using a Sheets deleteDeveloperMetadata filter matching its ID, key and exact owner value. Record the incident and before/after evidence. Never clear a gate by age, erase a receipt or submit a replacement approval to recover a lost acknowledgement.
