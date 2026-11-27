# Phase 2A: Read-only roster integration

The isolated connector is implemented but disabled. The sanitized loopback
fixture and the normal roster demo still operate without production data.
This branch adds no roster publishing action and has not been deployed.
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
contains no production Apps Script deployment URL, credentials, or writable roster endpoint.

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

The existing admin helper is not a roster authorization boundary. The new
routes `POST /roster/v1/login` and `POST /roster/v1/snapshot` use independent
authentication and strict server-derived roles: active SUPER_ADMIN can read
Affiliate and CSP; active CSP_ADMIN can read CSP only. The Apps Script reads
the existing admin rows and allowlist afresh. The IP must be on the active
allowlist even when legacy IP security is disabled. Duplicate admin identities
deny access. A signed ten-minute roster session is bound to the connecting IP
and current account credentials and role. The browser keeps the bearer only
in memory (cross-origin cookie behavior is not needed); sign-out clears this
browser's session and rendered source, but does not immediately revoke a copied
bearer. Account disablement, credential/role change or key rotation revokes
it server-side on the next request.

The Worker accepts only the exact configured frontend origin on roster
routes, uses edge `CF-Connecting-IP` (never JSON or XFF), and rejects marked
Worker subrequests. It signs an IP-bound request with a timestamp and nonce.
The origin verifies the signature before any sheet access; accepted nonces
are checked under an Apps Script lock, with bounded Script Properties storage
and a short signature window. The only runtime writes are replay and
login-rate counters in Script Properties. There is no sheet write, audit
append, attendance mutation, or roster publish action. Same-origin editor
handoff is in memory and does not receive the bearer. Saving a draft stores
staff IDs and assignments locally; use a trusted admin device, clear the
roster draft storage on shared/retired devices, and do not use real credentials
in the local preview.

## Local verification

Run `node --test tests/roster-live.test.cjs` with Playwright and Chrome
available, or `node --test tests/*.test.cjs` for the full suite. The live
browser test intercepts every remote call, overrides the disabled flag only
inside that test, and uses mock credentials and records. To manually review
the fixture UI, run the loopback command above. Opening the same source page
with `?source=live` verifies the production-shaped UI stays disabled.

## Pre-deployment gates and rollback

Version 58 (execute as owner, access Anyone) and Worker revision `ad7c02f1`
are owner-confirmed. No authenticated deployed-source hash or live integration
verification is claimed. Before any approved rollout:

1. Export and hash the deployed Version 58 source and compare it with the
   pre-change source at `eb2711b10addd40fcc3f2de1cd2536d641b9bdf6`.
   Verify the active Worker source against `ad7c02f1` and confirm that its
   unchanged legacy target is the supplied deployment URL. Rebase the additive
   changes if the deployed sources differ. Do not overwrite unrelated scripts.
2. Confirm the deployed admin, IP, roster and shift schemas, per-team active
   codes (including approved nonworking codes), exact stored IP representation,
   exclusions, and representative CSP overnight/leave mappings. Resolve
   duplicate/unknown or cross-team IDs before using a published copy.
3. In approved staging only, configure Worker `GAS_URL` to its corresponding
   Apps Script deployment and `ROSTER_ORIGIN` to the exact HTTPS origin (no
   path). For production, `GAS_URL` must be the existing exact URL. Use
   different random 32-byte hex values for `ROSTER_BRIDGE_KEY` (both sides) and
   `ROSTER_SESSION_KEY` (Apps Script only). Configure `ROSTER_TEAM_SHIFT_CODES`
   as JSON arrays keyed by Affiliate and CSP; optionally set
   `ROSTER_EXCLUDED_STAFF_IDS` as a JSON array. Keep both `ROSTER_ENABLED`
   flags and the frontend flag off until each planned stage is approved.
4. Verify direct edge ingress and subrequest rejection on the actual hostname.
   [Cloudflare documents](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-connecting-ip-in-worker-subrequests)
   that same-zone Worker subrequests can influence the IP header. Do not
   enable live access unless untrusted Worker/service-binding paths cannot
   reach the signer as a direct client. Check the configured origin, direct
   Apps Script denial, authorized and forbidden team reads, origin and IP
   denial, replay, role revocation, overnight data and legacy forwarding.
   Measure source read and shared lock contention against existing traffic.
5. Only with owner approval, enable the Apps Script and Worker roster flags
   and the separately reviewed frontend `rosterLiveEnabled` flag. The
   entry is `admin-roster-source.html?source=live`. No external leave
   integration is authorized; the existing manual verification remains.

Stop the preview server to roll back local testing. For an approved future
production rollout, disable the roster flags, restore Worker `ad7c02f1` and
the existing Apps Script deployment to Version 58, and revert the frontend
release. Retire the new roster keys and namespaced counters only after
rollback is verified. No roster sheet rollback is needed for Phase 2A.

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
