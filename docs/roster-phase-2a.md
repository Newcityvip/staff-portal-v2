# Phase 2A: Read-only roster discovery and fixture gate

This branch contains a sanitized loopback fixture, not a live connector. It
does not add an Apps Script action, publish a roster, read real staff data, or
modify a spreadsheet. The normal roster demo does not invoke the fixture API.
The existing admin CSV form gains the requested acknowledgment. No legacy API
contract or upload implementation changed; the checkbox is a client workflow
gate, not authorization for direct API clients.

## What is known

| Area | Evidence and limitation |
| --- | --- |
| Staff directory | Owner-confirmed `02_Staff_Master` headers: staff_id, full_name, login_id, email, team, role, status, joining_date, manager, phone, telegram_user_id, notes. Repository maps these fields or aliases. Use canonical staff_id; do not recover unknown IDs from names. |
| Shifts | Owner observed AM, AM1, PM1, PM, overnight GY, OFF, AL, SL and UL. The repository's `getShiftRule` reads code, start, end and active at positions 1, 2, 3 and 12. It does not establish the exact deployed headers, the active-value encoding, or how per-team catalogs are assigned. |
| Schedule | Owner-confirmed `04_Schedule_Master` headers: schedule_id, schedule_month, schedule_date, staff_id, login_id, full_name, team, shift_code, start_time, end_time, status, uploaded_by, uploaded_at, notes. Owner observed AL with status OFF. |
| Time zones | Repository maps Affiliate to Asia/Colombo and CSP to Asia/Manila; its existing sheet-time helper formats Date-valued cells with a Colombo constant. Verify source storage and time conversion with a sanitized CSP example before wiring the production source. |
| Status semantics | The repository single-date writer stores OFF/AL/SL/UL as status equal to the shift code; CSV upload preserves the normalized status supplied by the importer. Both can explain why a sheet has more than one nonworking convention. The fixture reader keeps the published status and uses the shift code for classification. This is not approval of any write mapping. |
| Writers | Repository exposes CSV upload (existing-row map can prefer a later duplicate) and single-date update (selects the first match). Both locate existing rows by normalized date plus login ID. An authoritative staff_id/date uniqueness constraint and current duplicate counts are unverified. Manual edits, the separate leave system and any other triggers or integrations require owner inventory; none was queried. |
| Brand mapping | Owner-confirmed Staff Master has no brand column. Repository constants list tabs 01 through 12; that is not a live tab inventory. Keep `13_Roster_Brand_Mapping` tentative. |

## Fixture behavior

Run `node scripts/roster-preview.cjs --fixture 8770` and open
`http://127.0.0.1:8770/admin-roster-source.html`. The explicit fixture server
must bind to loopback, serves only generated sanitized rows, and simulates an
already authenticated admin. A normal preview does not serve this route. On a
non-loopback static page, fixture requests are disabled. The repository
contains no production roster URL, credentials, or writable roster endpoint.

The snapshot is one batched request for one team and month plus adjacent
months. It uses a response-body deadline, defensive team checks, a scoped
revision, and no polling. A malformed or unresolved source never loads
synthetic demo staff. Duplicates, ambiguous times/statuses, unknown IDs and
unknown shifts block draft import; no source row is overwritten. Staff who
joined after the selected month began are viewable but conservatively excluded
from whole-month generation until a partial-employment cadence policy is
approved. Inactive staff remain visible in published schedules. Affiliate
brand mapping starts unassigned. Existing local group transfers represent
effective-month draft proposals only.

The local editor reuses the Phase 1G generator. Existing published leave is
retained from Schedule Master by shift code even when preparing a new draft;
manual AL/SL/UL stays editable and protected during generation. No separate
leave request tab, balances or requests are read or changed. Published leave
overrides remain local and do not update any external record.

Local fixture savings are keyed by simulated admin namespace, team and month,
separate from the original synthetic demo. They retain roster assignments,
rules and source revision, not credentials or directory names. A changed
source disables resume and offers a comparison before opening a replacement.
No replacement writes the local saved draft until the admin explicitly saves.

## Authentication and deployment gate

The existing admin helper can use a client role or fall back to SUPER_ADMIN;
it is not a roster authorization boundary. Existing browser IP fields do not
establish a trusted client IP. The fixture contract requires a verified
gateway, a server-issued roster-read session (maximum ten minutes), an
active server-derived admin role, and a trusted allowed IP before any read.
It strips non-roster fields. Staff and unknown roles are denied; CSP Admin
cannot read Affiliate even with a forged client role. This verifies gate
behavior, not a deployed gateway or authenticated production session.

Before building or deploying the actual read endpoint, supply:

1. In Apps Script **Deploy > Manage deployments**, the active version and
   execution/access mode for the existing production deployment; do not
   include the deployment ID or any secrets.
2. In Cloudflare, a redacted route/forwarding excerpt showing whether the
   Worker derives the client IP from the trusted edge, strips client IP/role
   claims, and how the upstream authenticates the Worker. Confirm whether the
   Apps Script origin can be reached directly and how a roster-specific
   origin would deny such requests. Do not include secrets, IP allowlist
   values, or tokens.
3. A read-only schema verification: exact shift header row, active-value and
   Affiliate/CSP mapping, sanitized examples of a CSP overnight schedule and
   OFF/AL/SL/UL statuses, and the current tab names. Confirm where server-side
   active admin roles and roster exclusions should be resolved.
4. Aggregate counts only: duplicate staff_id/date keys by team/month and
   unknown/mismatched IDs, plus an inventory of processes that can write
   Schedule Master. Do not share private records.

Prefer a separately authorized roster read gateway and private read-only
origin. If Apps Script is used as that origin, require authenticated
server-to-server requests with origin-bound verification and replay
protection before Sheet access, including on the direct URL. Production
sessions must bind the authenticated admin, trusted IP and roster audience;
recheck revocation and role server-side, use HTTPS/secure HttpOnly cookies
with an explicit origin policy, and deny on missing proof. Do not put secrets
or tokens in frontend code, URLs or local storage. No deployment steps are
authorized by this branch. Rollback for local evaluation is stopping the
fixture server; no live production rollback is needed.

## Phase 2B proposal (not implemented)

- Verify that any mapping store name is unused. Proposed append-only
  effective-month history: canonical staff_id, team, group, effective
  month/range, inclusion setting, change ID, editor and timestamp. Restrict
  Affiliate group changes to Super Admin and retain historical memberships.
- Preview exact adds/updates, untouched rows, conflicts and leave markers;
  require the future-leave acknowledgment bound to the specific reviewed
  revision. Never publish directly from a browser snapshot.
- Enforce authorization and team/month on the server, canonical uniqueness,
  shift/leave validation and joining eligibility. Compare fresh source
  revisions against the reviewed revision just before writes. Preserve
  unrelated teams, months and staff.
- Inventory and coordinate every writer or establish a single-writer
  boundary. Apps Script locks alone do not protect against manual edits or
  independent integrations. Prefer conditional writes where supported;
  otherwise stop on contention and require controlled writer coordination.
- Use an idempotency key, a pre-write backup of touched records and an audit
  entry, then read back and verify the exact counts and assignments. Design
  recovery for partial failure before rollout. Roll back only touched rows
  after checking they have not changed again. Leave overrides require a
  separate policy decision; this phase does not integrate leave entitlements.
