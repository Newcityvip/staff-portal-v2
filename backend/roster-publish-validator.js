import { contextFor, draftFor, key } from "../js/roster-model.js";
import { prepareRosterSource, publicationConfiguration, sourceDraft } from "../js/roster-source.js";
import { validate } from "../js/roster-generator.js";

export function prepare(payload, team, month, approval, configuration, records) {
  const source = prepareRosterSource({ ...payload, ok: true, principal: "server", teams: [team] }, team, month);
  if (!source.usable) throw Error("The published schedule has ambiguous or conflicting rows.");
  if (!approval || !configuration || !Array.isArray(approval.memberships) || !Array.isArray(approval.groups) ||
    !approval.rules || !approval.coverage || !approval.demand || !approval.preferences || !Array.isArray(approval.transitions)) {
    throw Error("No approved publishing rules for this team and month.");
  }
  const ids = approval.memberships.map(p => p.id), selected = new Set(ids);
  const model = sourceDraft(source, ids);
  if (!ids.length || selected.size !== ids.length || model.people.length !== ids.length ||
    approval.memberships.some(p => p.group !== "unassigned" && !approval.groups.some(g => g.id === p.group))) {
    throw Error("The approved staff scope no longer matches the directory.");
  }
  model.groups = approval.groups.map(g => ({ ...g, team }));
  model.memberships = approval.memberships.map(p => ({ ...p, from: month }));
  model.transitions[team] = approval.transitions;
  const draft = draftFor(model, team, month);
  for (const field of ["rules", "coverage", "demand", "preferences"]) draft[field] = approval[field];
  const ctx = contextFor(model, team, month);
  if (canonical(publicationConfiguration(ctx)) !== canonical(configuration)) throw Error("Review the server-approved roster configuration.");
  if (!Array.isArray(records) || !records.length || records.length > 4000) throw Error("Invalid roster size.");
  const dates = new Set(ctx.dates), shifts = new Map(ctx.catalog.map(shift => [shift.id, shift]));
  const before = new Map(source.rows.map(row => [key(row.id, row.date), row]));
  const cells = { ...ctx.draft.cells }, seen = new Set(), changed = [];
  const counts = { new: 0, updated: 0, unchanged: 0, conflicting: 0 };
  for (const row of records) {
    if (!row || Object.keys(row).sort().join(",") !== "date,shift,staffId" || !selected.has(row.staffId) ||
      !dates.has(row.date) || !shifts.has(row.shift)) throw Error("Invalid staff, date or shift for the approved scope.");
    const k = key(row.staffId, row.date), previous = before.get(k), shift = shifts.get(row.shift);
    if (seen.has(k)) throw Error("Duplicate staff/date assignment.");
    seen.add(k);
    if (previous && ["AL", "SL", "UL"].includes(previous.code) && previous.code !== row.shift) throw Error("Published leave cannot be replaced.");
    cells[k] = row.shift;
    if (previous?.code === row.shift) { counts.unchanged++; continue; }
    counts[previous ? "updated" : "new"]++;
    changed.push({ id: row.staffId, date: row.date, before: previous ? [previous.code, previous.start, previous.end, previous.status] : null,
      shift: shift.id, start: shift.start,
      end: shift.end, status: shift.kind === "work" ? "WORKING" : shift.id });
  }
  const validation = validate(ctx, cells);
  counts.conflicting = validation.errors.length;
  return { counts, changed, conflicts: validation.errors.slice(0, 15).map(issue => issue.label) };
}

function canonical(value) {
  return JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item) ?
    Object.fromEntries(Object.keys(item).sort().map(k => [k, item[k]])) : item);
}
