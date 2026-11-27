export const teams = ["Affiliate", "CSP"];
export const optionalLimit = value => value == null || typeof value === "string" && !value.trim() ? null : value;
export const key = (id, date) => id + "|" + date;
export const dayIndex = date => Date.parse(date + "T00:00:00Z") / 86400000;
export const dateAt = day => new Date(day * 86400000).toISOString().slice(0, 10);
export const previousMonth = month => dateAt(dayIndex(month + "-01") - 1).slice(0, 7);
export const nextMonth = month => dateAt(dayIndex(month + "-01") + datesFor(month).length).slice(0, 7);
export const weekday = date => (dayIndex(date) + 4) % 7;
export const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function datesFor(month) {
  const start = dayIndex(month + "-01");
  const dates = [];
  for (let i = 0; i < 31 && Number.isFinite(start); i++) {
    const date = dateAt(start + i);
    if (!date.startsWith(month + "-")) break;
    dates.push(date);
  }
  return dates;
}

const code = (id, kind, start = "", end = "", color = "#82d9ee") => ({ id, kind, start, end, color });
const leaveCodes = () => [code("OFF", "off", "", "", "#a6b3c9"), code("AL", "leave", "", "", "#97dfab"),
  code("SL", "leave", "", "", "#fec783"), code("UL", "leave", "", "", "#eea5bb")];
export function seed() {
  const names = ["Avery Vale", "Briar Finch", "Cameron Flint", "Dara Pine", "Ellis Grove", "Frankie Moss", "Gray Cedar",
    "Harper Reed", "Indigo Frost", "Jules Stone", "Kit Birch", "Lane Rivers", "Morgan Tide", "Nico Ash", "Oakley Snow",
    "Parker Fern", "Quinn Lake", "Remy Dune", "Sage Bloom", "Taylor Bay", "Uma Cliff", "Val Wren", "Winter Banks", "Zion Lark"];
  const people = names.map((name, i) => ({ id: "SYN-" + String(i + 1).padStart(3, "0"),
    login: "SYNLOGIN" + String(i + 1).padStart(3, "0"), name, team: i < 18 ? "Affiliate" : "CSP" }));
  return {
    people, groups: [{ id: "old", name: "OLD Brands", team: "Affiliate" }, { id: "new", name: "NEW Brands", team: "Affiliate" },
      { id: "csp", name: "CSP Operations", team: "CSP" }],
    memberships: people.map((person, i) => ({ id: person.id, group: i < 10 ? "old" : i < 18 ? "new" : "csp", from: "2020-01" })),
    catalogs: {
      Affiliate: [code("AM", "work", "06:30", "15:30"), code("AM1", "work", "09:30", "18:30", "#9bbdff"),
        code("PM1", "work", "12:30", "21:30", "#c6adf4"), code("PM", "work", "14:30", "23:30", "#f7af9c"), ...leaveCodes()],
      CSP: [code("DAY", "work", "07:00", "16:00"), code("MID", "work", "13:00", "22:00", "#f7af9c"),
        code("NIGHT", "work", "22:00", "07:00", "#c6adf4"), ...leaveCodes()]
    },
    leave: { [key("SYN-003", "2026-12-09")]: "AL", [key("SYN-015", "2026-12-17")]: "SL",
      [key("SYN-021", "2026-12-11")]: "UL" },
    drafts: {}, snapshots: [], transitions: { Affiliate: [["AM", "AM1"], ["AM1", "PM1"], ["PM1", "PM"]], CSP: [] }
  };
}
export const draftKey = (team, month) => team + "|" + month;
export const newDraft = () => ({ cells: {}, locks: {}, staffLocks: {}, coverage: {}, demand: {}, preferences: {},
  sources: {}, leaveOverrides: {}, leaveAudit: [],
  rules: { offPolicy: "paired", weeklyOff: 2, maxRun: 6, rest: 11, fair: true }, revision: 0 });
export function draftFor(model, team, month) {
  const id = draftKey(team, month);
  if (!model.drafts[id]) {
    model.drafts[id] = newDraft();
    for (const person of model.people.filter(p => p.team === team)) {
      for (const date of datesFor(month)) {
        const k = key(person.id, date);
        if (model.leave[k]) model.drafts[id].cells[k] = model.leave[k];
      }
    }
  }
  return model.drafts[id];
}
export function groupMatches(model, id, month) {
  const overrides = model.memberships.filter(m => m.id === id && m.temporary && m.from === month);
  if (overrides.length) return overrides;
  const sorted = model.memberships.filter(m => m.id === id && !m.temporary && m.from <= month).sort((a, b) => b.from.localeCompare(a.from));
  return sorted.filter(m => m.from === sorted[0]?.from);
}
export const groupOf = (model, id, month) => groupMatches(model, id, month)[0]?.group || "unassigned";
export function transfer(model, id, group, from, temporary = false) {
  return transferMany(model, [id], group, from, temporary);
}
export function transferMany(model, ids, group, from, temporary = false) {
  const unique = new Set(ids);
  const people = model.people.filter(p => unique.has(p.id));
  if (!unique.size || people.length !== unique.size || new Set(people.map(p => p.team)).size !== 1 || !datesFor(from).length ||
    (group !== "unassigned" && !model.groups.some(g => g.id === group && g.team === people[0].team))) return false;
  model.memberships = model.memberships.filter(m => !unique.has(m.id) || m.from !== from || (temporary && !m.temporary));
  model.memberships.push(...people.map(p => ({ id: p.id, group, from, temporary })));
  return true;
}
export function contextFor(model, team, month) {
  const people = model.people.filter(p => p.team === team).map(p => ({ ...p, group: groupOf(model, p.id, month) }));
  const previous = previousMonth(month);
  const recorded = [...model.snapshots].reverse().find(s => s.team === team && s.month === previous);
  const following = nextMonth(month);
  const nextRecord = [...model.snapshots].reverse().find(s => s.team === team && s.month === following);
  const draft = draftFor(model, team, month), leave = { ...model.leave };
  for (const overrides of [draft.leaveOverrides, recorded?.planning?.leaveOverrides ?? model.drafts[draftKey(team, previous)]?.leaveOverrides,
    nextRecord?.planning?.leaveOverrides ?? model.drafts[draftKey(team, following)]?.leaveOverrides]) {
    for (const k of Object.keys(overrides || {})) delete leave[k];
  }
  return { team, month, dates: datesFor(month), people, groups: model.groups.filter(g => g.team === team),
    catalog: model.catalogs[team], leave, approvedLeave: model.leave, draft,
    previous: recorded?.cells || model.drafts[draftKey(team, previous)]?.cells || {},
    previousCatalog: recorded?.catalog || model.catalogs[team],
    next: nextRecord?.cells || model.drafts[draftKey(team, following)]?.cells || {},
    nextCatalog: nextRecord?.catalog || model.catalogs[team], transitions: model.transitions?.[team] || [],
    conflicts: people.filter(p => groupMatches(model, p.id, month).length > 1 ||
      (p.group !== "unassigned" && !model.groups.some(g => g.id === p.group && g.team === team))).map(p => p.id) };
}
export function snapshot(context) {
  const { team, month, dates, people, groups, catalog, draft, leave } = context;
  const leaveForScope = Object.fromEntries(people.flatMap(person => dates.map(date => key(person.id, date)))
    .filter(k => leave[k]).map(k => [k, leave[k]]));
  return structuredClone({ team, month, dates, people, groups, catalog, revision: draft.revision, cells: draft.cells,
    planning: { coverage: draft.coverage, demand: draft.demand || {}, rules: draft.rules, preferences: draft.preferences, leave: leaveForScope,
      sources: draft.sources, leaveOverrides: draft.leaveOverrides, leaveAudit: draft.leaveAudit } });
}
export const isManualLock = (context, id, date) => Boolean(context.draft.staffLocks[id] || context.draft.locks[key(id, date)]);
export const importedLeave = (context, k) => context.approvedLeave?.[k] || context.leave[k] || context.draft.leaveOverrides?.[k]?.original;
export const isLeaveCell = (context, k) => context.catalog.some(s => s.kind === "leave" && s.id === context.draft.cells?.[k]);
export const heldBlank = (context, k) => context.draft.leaveOverrides?.[k]?.replacement === "" && !context.draft.cells?.[k];
export const blankHoldShift = { id: "", kind: "hold" };
export const protectedNonWork = (context, k) => Boolean(context.leave[k] || isLeaveCell(context, k) || heldBlank(context, k));
export const isLocked = (context, id, date) => {
  const k = key(id, date);
  return Boolean(context.leave[k] || context.draft.leaveOverrides?.[k] || isLeaveCell(context, k) || isManualLock(context, id, date));
};
export function assignmentSource(context, k) {
  if (context.draft.leaveOverrides?.[k]) return "overridden";
  if (context.leave[k]) return "approved";
  if (isLeaveCell(context, k)) return "manual-leave";
  return context.draft.sources?.[k] || (context.draft.cells[k] ? "legacy" : "");
}
export function assignCell(draft, k, value, source = "manual") {
  if (value) { draft.cells[k] = value; draft.sources[k] = source; }
  else { delete draft.cells[k]; delete draft.sources[k]; }
}
export function assignmentsFromGeneration(draft, cells) {
  for (const k of new Set([...Object.keys(draft.cells), ...Object.keys(cells)])) {
    if ((draft.cells[k] || "") !== (cells[k] || "")) assignCell(draft, k, cells[k], "generated");
  }
}
export function overrideApprovedLeave(context, draft, changes, reason, at, clearLocks = false) {
  const note = reason.trim();
  if (!note || note.length > 500 || !changes.length) return false;
  if (!changes.every(([k, value]) => {
    const [id, date] = k.split("|");
    return importedLeave(context, k) && context.people.some(p => p.id === id) && context.dates.includes(date) &&
      (clearLocks || !isManualLock(context, id, date)) && (value === "" || context.catalog.some(s => s.id === value));
  })) return false;
  for (const [k, value] of changes) {
    const original = importedLeave(context, k);
    const entry = { k, original, previous: draft.cells[k] || "", replacement: value, reason: note, at };
    draft.leaveOverrides[k] = entry;
    draft.leaveAudit.push(entry);
    assignCell(draft, k, value);
  }
  return true;
}
export function resetRosterScope(draft, original, ids, dates, { whole = false, group = "" } = {}) {
  const staff = new Set(ids), keys = new Set(ids.flatMap(id => dates.map(date => key(id, date))));
  const restoreKeys = (field, rosterKeys) => {
    for (const k of rosterKeys) {
      if (Object.hasOwn(original[field] || {}, k)) draft[field][k] = structuredClone(original[field][k]);
      else delete draft[field][k];
    }
  };
  for (const field of ["cells", "locks", "sources", "leaveOverrides"]) restoreKeys(field, keys);
  for (const field of ["staffLocks", "preferences"]) restoreKeys(field, staff);
  draft.leaveAudit = [...draft.leaveAudit.filter(e => !keys.has(e.k)), ...structuredClone(original.leaveAudit.filter(e => keys.has(e.k)))]
    .sort((a, b) => a.at.localeCompare(b.at));
  if (whole) for (const field of ["coverage", "demand", "rules"]) draft[field] = structuredClone(original[field]);
  else if (group) for (const field of ["coverage", "demand"]) {
    restoreKeys(field, new Set([...Object.keys(draft[field]), ...Object.keys(original[field])].filter(k => k.startsWith(group + "|"))));
  }
}
export function clearRosterAssignments(context, draft, ids, mode, reason = "", at = "") {
  const people = context.people.filter(p => ids.includes(p.id));
  const keys = people.flatMap(p => context.dates.map(date => key(p.id, date)));
  const approved = keys.filter(k => importedLeave(context, k) && (context.leave[k] || context.draft.cells[k]));
  if (mode === "all" && approved.length && !overrideApprovedLeave(context, draft, approved.map(k => [k, ""]), reason, at, true)) return false;
  const protectedKeys = new Set(approved);
  if (mode === "all") for (const p of people) delete draft.staffLocks[p.id];
  for (const k of keys) {
    if (mode === "all") {
      delete draft.locks[k];
      if (!protectedKeys.has(k)) assignCell(draft, k, "");
    } else if (!isLocked(context, ...k.split("|")) && (mode === "unlocked" || draft.sources[k] === "generated")) {
      assignCell(draft, k, "");
    }
  }
  return true;
}
export function totals(catalog, row) {
  const tally = { work: 0, off: 0, leave: 0 };
  for (const value of row) {
    const kind = catalog.find(s => s.id === value)?.kind;
    if (kind) tally[kind]++;
  }
  return tally;
}
export function coverage(people, dates, cells) {
  return dates.map(date => {
    const counts = Object.create(null);
    for (const person of people) {
      const value = cells[key(person.id, date)];
      if (value) counts[value] = (counts[value] || 0) + 1;
    }
    return counts;
  });
}
export function previousPattern(context, keepAssigned = false) {
  const cells = { ...context.draft.cells };
  const previousDates = datesFor(previousMonth(context.month));
  for (const person of context.people) {
    context.dates.forEach((date, index) => {
      if (isLocked(context, person.id, date) || keepAssigned && cells[key(person.id, date)]) return;
      const source = previousDates[index];
      const value = source && context.previous[key(person.id, source)];
      if (value && context.catalog.some(s => s.id === value && s.kind !== "leave")) cells[key(person.id, date)] = value;
    });
  }
  return cells;
}

export function createHistory(model) {
  let current = model;
  const undo = [], redo = [];
  return {
    get current() { return current; },
    get canUndo() { return undo.length > 0; },
    get canRedo() { return redo.length > 0; },
    change(edit) {
      const next = structuredClone(current);
      edit(next);
      if (JSON.stringify(next) === JSON.stringify(current)) return;
      undo.push(current);
      if (undo.length > 40) undo.shift();
      current = next;
      redo.length = 0;
    },
    undo() { if (undo.length) { redo.push(current); current = undo.pop(); } },
    redo() { if (redo.length) { undo.push(current); current = redo.pop(); } }
  };
}
export const storageKey = "spv2.syntheticRoster.v1";
export function migrate(saved) {
  const model = saved.model;
  model.transitions ??= seed().transitions;
  for (const draft of Object.values(model.drafts)) {
    draft.demand ??= {};
    draft.sources ??= {};
    draft.leaveOverrides ??= {};
    draft.leaveAudit ??= [];
    for (const rule of Object.values(draft.coverage)) if (rule && typeof rule === "object") rule.max = optionalLimit(rule.max);
    for (const rule of Object.values(draft.demand)) if (rule && typeof rule === "object") {
      rule.maxOff = optionalLimit(rule.maxOff);
      rule.preferredOff = optionalLimit(rule.preferredOff);
    }
    if (draft.rules.offPolicy !== "paired") {
      draft.legacyOff = { minimum: draft.rules.weeklyOff, staff: Object.fromEntries(Object.entries(draft.preferences)
        .filter(([, p]) => p.weeklyOff != null || p.consecutiveOff != null)
        .map(([id, p]) => [id, { minimum: p.weeklyOff, consecutive: p.consecutiveOff }])) };
      draft.rules.offPolicy = "paired";
    }
  }
  return saved;
}
export function restore(storage) {
  try {
    const saved = JSON.parse(storage.getItem(storageKey) || "null");
    if ([1, 2, 3].includes(saved?.schema) && Array.isArray(saved.model?.people) && saved.model?.catalogs) return migrate(saved);
  } catch {}
  return { model: seed(), team: "Affiliate", month: "2026-12" };
}
export function save(storage, model, team, month) {
  storage.setItem(storageKey, JSON.stringify({ schema: 3, model, team, month }));
}
