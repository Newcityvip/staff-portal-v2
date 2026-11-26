# Monthly Roster Builder: Phase 1

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

1. Run **Generate all groups** on Affiliate / December 2026. Examine separate
   OLD/NEW sections, the combined totals, and the protected AL/SL cells.
2. Select one cell, or use Multi-select or Shift-click for a range. Assign a
   shift, copy/paste in selection order, clear, or lock. Locked cells cannot
   be reassigned by editing, pasting, copying a prior pattern, or generation.
3. Under **Brand groups**, create/edit a group or set an effective-month
   transfer. **Save draft** stores the workspace on this browser/origin only.
   Preview shows the whole team. Review confirmation requires the leave
   acknowledgment; with no blocking errors it creates a local snapshot.
4. Export current draft or snapshot via Excel/CSV. Choose combined or a
   specific group in the export control. Every export is labeled synthetic.
   **Do not upload the sample CSV.**
5. To demonstrate infeasibility, open **Shift rules** and set minimum AM
   coverage to 11 for OLD Brands on one date. Run generation. Change the
   minimum back (or use Undo) before continuing. CSP demonstrates overnight.

## Behavior and limits

- The worker uses deterministic candidate ordering and bounded backtracking
  (180,000 assignment steps or approximately 3.5 seconds). A budget result
  does not prove infeasibility and does not replace the current draft.
  Fairness and weekly shift rotation are ordering preferences, not claims
  of global optimality. Configured coverage, fixed shifts, known-rest
  boundaries, work streaks, leave, locks and weekly OFF are hard rules.
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
