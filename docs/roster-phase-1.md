# Monthly Roster Builder: Phases 1, 1B and 1C

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

- **Weekly Demand & OFF Planning** stores workload, maximum/preferred OFF,
  and minimum working staff by team, group and month. Specific dates inherit
  their weekday settings until overridden. Capacity is the smaller of the OFF
  cap and available headcount after confirmed leave and mandatory work/shift
  minima. The rolling seven-day capacity check compares usable slots to twice
  group headcount; sufficient aggregate capacity is not proof of feasible pairs.
- Phase 1C enforces a recurrent seven-day cadence per staff member: two
  consecutive regular OFF days and five non-OFF dates. The cadence may straddle
  Sunday/Monday or a month boundary. Leave occupies a non-OFF date without
  counting as work or regular OFF. The solver explores tentative OFF phases
  while evaluating shift feasibility; it does not fix OFF independently.
  A preferred OFF pair is soft. A fixed cadence is a deliberate prototype
  interpretation; rotating OFF weekdays between weeks would need a separate
  approved policy. A conflict blocks a result rather than assigning extra OFF.
- Within a working cycle, use the same shift except for one configured
  adjacent adjustment on the day immediately before the pair. After two OFF
  days, the next cycle may use a different shift. Affiliate defaults are
  AM/AM1, AM1/PM1 and PM1/PM; CSP starts with no pair-eve exceptions.
  The team transition list is editable. Fixed shift, allowed shifts, rotation
  restrictions, work streak and elapsed rest remain mandatory.
- The planner checks available previous and next boundary records and warns
  when either side is incomplete, including during simulated confirmation.
  A provisional synthetic snapshot does not certify unknown dates. Existing
  local drafts retain cells, snapshots and preferences; old minimum-only
  settings are archived at migration and are not enforced in Phase 1C.
- Daily reporting adds working, OFF, AL/SL/UL, shift totals, shortfalls and
  OFF capacity. Staff reporting adds per-code totals, paired-week counts,
  work streaks and transitions. Candidate comparisons include scoped hard
  validation, workload alignment (lower penalty is better), transition and
  workday spread, target coverage, and PM share. XLSX adds a Planning summary
  tab for new snapshots; existing grid sheets and the flat CSV stay compatible.

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
- Fixed/allowed shifts, rotation restriction, paired OFF, work streak and
  rest are mandatory. Preferred shift, weekly rotation and preferred OFF pair
  are soft ordering preferences.
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
- Historical Phase 1B benchmark against Phase 1 commit `07f72fa`: with one AM
  per group per day and two NEW PM on Dec 4, the same staff, leave and remaining
  mandatory inputs produced 88/401 PM assignments (21.95%) in Phase 1 and
  340/402 (84.58%) in the selected Phase 1B candidate. Both passed the current
  hard-rule validator. This is a synthetic comparison, not a production
  staffing target or proof of optimality.

Phase 1C comparison against `dfcd333` uses the same synthetic December people,
leave, coverage (one AM per Affiliate group daily, one DAY per CSP group),
rest and streak constraints. The paired policy and shift-cycle rule are the
intentional differences. Metrics count complete, non-overlapping seven-day
windows inside the displayed month. A window spanning an OFF pair split at
its ends counts if it matches a valid repeating weekly pattern.

| Team | Paired windows | Excess OFF | Group-days covered | PM / working | In-cycle changes |
| --- | --- | --- | --- | --- | --- |
| Affiliate | 8/72 to 72/72 | 17 to 0 | 62 to 62 | 339/401 to 335/400 | 24 to 0 |
| CSP | 3/24 to 24/24 | 5 to 0 | 31 to 31 | 0/135 to 0/131 | 61 to 0 |

The benchmark test logs elapsed local candidate generation per run. Results
are synthetic; the bounded search is not a proof of mathematical optimality.

## Behavior and limits

- The worker uses deterministic candidate ordering and bounded backtracking
  (up to three searches, each capped at 60,000 steps or about 1.15 seconds).
  Candidate variants use different tie-breaks and OFF phases. A budget result
  does not prove infeasibility and does not replace the current draft.
  Fairness and weekly shift rotation are ordering preferences, not claims
  of global optimality. Configured coverage, fixed shifts, known-rest
  boundaries, work streaks, leave, locks, maximums and weekly OFF are hard rules.
- Leave does not count as OFF. Missing adjacent-month records are explicit
  warnings, not evidence of cross-month rest or OFF compliance.
  Prior-month copy aligns by calendar day, skips leave and
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
