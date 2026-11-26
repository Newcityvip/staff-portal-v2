# Monthly Roster Builder: Phase 1 and 1B

This isolated prototype contains fictional identities, a synthetic leave
fixture and no production connectivity. No login, permission, dashboard or
attendance code is loaded by this page. Conversely, existing portal pages
have no roster entry point, assets or requests. The prototype uses a restrictive
Content Security Policy to block API connections as well.

## Local preview

From the repository root run `node scripts/roster-preview.cjs`
and open `http://127.0.0.1:8765/admin-roster.html`. The module worker needs HTTP;
opening the HTML as a file will not work. No sign-in is required for the
fictional prototype. Do not deploy this page as an authorized tool.

An optional mobile preview binds only the private IPv4 address you specify:
`node scripts/roster-preview.cjs --lan <PC-Wi-Fi-IPv4> 8766`. Visit the URL
printed by the server on a phone on the same trusted Wi-Fi. Use
`Get-NetIPAddress -AddressFamily IPv4` on Windows to find the Wi-Fi address;
the CLI rejects an address not assigned to this PC or outside private ranges.
Stop with Ctrl+C; LAN mode expires after 30 minutes. No firewall rule or tunnel
is added. If local firewall policy or Wi-Fi client isolation blocks access,
use the screenshots and mobile browser fixtures; do not open a public port.

1. Run **PM priority / Entire team** on Affiliate / December 2026, compare the
   candidates, and explicitly **Apply candidate**. Examine separate
   OLD/NEW sections, the combined totals, and the protected AL/SL cells.
2. Select one cell, or use Multi-select or Shift-click for a range. Assign a
   shift, copy/paste in selection order, clear, or lock. Locked cells cannot
   be reassigned by editing, pasting, copying a prior pattern, or generation.
3. Under **Brand groups**, create/edit a group or select one or more staff for
   a temporary or onward effective-month transfer. A temporary transfer takes
   precedence for that month only. An onward transfer replaces a transfer at
   the same month and respects any later explicit effective-month entries.
   Earlier months and snapshots do not change. Undo reverts draft changes.
   **Save draft** stores the workspace on this browser/origin only.
   Preview shows the whole team. Review confirmation requires the leave
   acknowledgment; with no blocking errors it creates a local snapshot.
4. Export current draft or snapshot via Excel/CSV. Choose combined or a
   specific group in the export control. Every export is labeled synthetic.
   **Do not upload the sample CSV.**
5. To demonstrate infeasibility, open **Coverage matrix** and set minimum and
   target AM coverage to 11 for OLD Brands on one date. Run generation. Change the
   minimum back (or use Undo) before continuing. CSP demonstrates overnight.

## Configuration and results

- Coverage rows are scoped to team, group, month and shift. A checked date rule
  supersedes its weekday rule, which supersedes the daily default. Unchecking
  an override restores inheritance after saving. Phase 1 numeric minimums
  migrate as a matching target. New defaults are zero minimum/target with no
  maximum. Disabled automatic shifts require zero minimum and target;
  existing manual or locked entries may remain within the maximum.
- PM Priority ranks PM highly after mandatory constraints; Balanced aims for
  a more even staff shift mix; Custom uses targets and priorities; Previous
  Month Pattern prefers available same-calendar-day shifts/OFF while still
  enforcing current constraints. Manual prior-month copy remains a separate
  editor operation. The scope can be team, selected group or staff touched by
  selected cells. Fill empty cells only preserves all populated cells.
- Fixed/allowed shifts, rotation restriction, weekly/consecutive OFF,
  work streak and rest are mandatory. Preferred shift, weekly rotation,
  preferred OFF weekdays and OFF streak are soft ordering preferences.
  Rotation restriction means one working shift per staff member for this
  roster month; it does not rewrite the previous month.
- Up to three distinct valid candidates are displayed with a comparison and
  a read-only grid. Cancellation and discard leave the draft unchanged.
  Results report assignment totals, working mix, individual workload,
  preferences, and group and combined daily coverage. **PM coverage** means
  PM working assignments divided by all working assignments. Preference
  satisfaction counts work assignments matching a preferred shift and
  preferred OFF weekdays honored; it does not score every soft preference.
- Validation links jump to the relevant cell or coverage count. Blocking
  issues prevent the final roster preview and simulated confirmation.
  Candidate review can still show a partial-scope result; unrelated
  incomplete cells must be resolved before final preview. The new
  Future_Leave_Requests acknowledgment is fresh each time confirmation opens.
- December Affiliate benchmark against Phase 1 commit `07f72fa`: with one AM
  per group per day and two NEW PM on Dec 4, the same staff, leave and remaining
  mandatory inputs produced 88/401 PM assignments (21.95%) in Phase 1 and
  340/402 (84.58%) in the selected Phase 1B candidate. Both passed the current
  hard-rule validator. This is a synthetic comparison, not a production
  staffing target or proof of optimality.

## Behavior and limits

- The worker uses deterministic candidate ordering and bounded backtracking
  (up to three searches, each capped at 60,000 steps or about 1.15 seconds).
  Candidate variants use different tie-breaks and OFF phases. A budget result
  does not prove infeasibility and does not replace the current draft.
  Fairness and weekly shift rotation are ordering preferences, not claims
  of global optimality. Configured coverage, fixed shifts, known-rest
  boundaries, work streaks, leave, locks, maximums and weekly OFF are hard rules.
- OFF is a configurable Monday-Sunday minimum; leave does not count as OFF.
  A missing previous-month boundary is an explicit warning, not evidence
  of rest or OFF compliance. An incomplete final week reports remaining OFF
  obligations. Prior-month copy aligns by calendar day, skips leave and
  preserves locks; shorter previous months leave the extra dates untouched.
- Draft storage is browser-only and is not designed for shared multi-user
  editing. The UI intentionally has no live write, deploy or upload path.
  The existing CSV upload reminder is not changed.
- Formatted export uses the MIT-licensed, vendored ExcelJS 4.4.0 browser
  distribution, loaded from the same origin only when Excel is requested.
  Bundle SHA-256: `7e49da68588e250dbb8bba190d2caa8ab3787cc0284bda1d8b2f805c4df742c9`.
  It was extracted without modification from the integrity-verified npm
  tarball. Tests reopen generated workbooks and parse CSV with the existing
  flat importer without calling its write path.

## Phase 2 release gates

Before live integration, obtain read-only evidence of exact live directory,
schedule and shift headers/types and duplicate counts; private confirmation
of real brand-to-ID mapping; authoritative leave headers, date and timezone
semantics, statuses/transitions and redacted examples; deployed Apps Script
version and redacted Worker authentication/forwarding configuration; and a
complete list of writers or integrations with schedule/leave write access.
No tokens, passwords or real staff IDs should be included in the PR.

Proposed authorization: a separate, short-lived, server-verified roster
session bound to an active admin. Derive permissions and team scope from
server records on every request, retain existing IP checks, and verify that
the Apps Script path cannot bypass the gate. Never trust localStorage role,
client-supplied scope or the legacy default-admin fallback. Pilot reads in
staging before any publisher is considered. Publishing also requires stale
preview, writer coordination, audit and partial recovery controls.

No production rollout or rollback is needed for Phase 1. Keep the PR draft.
