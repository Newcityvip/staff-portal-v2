import { blankHoldShift, dateAt, dayIndex, heldBlank, isLocked, key, protectedNonWork, totals,
  weekday, weekdays, datesFor, previousMonth } from "./roster-model.js";
import { coverageKey, coverageReport, coverageRule, eligible, staffRules, validCoverage } from "./roster-policy.js";
import { alignment, boundary, boundaryPhases, demandRule, desiredOff, endingPhase, offCapacity,
  pairedPolicy, pairNames, phaseIndices, phasesFor, validDemand, workloads } from "./roster-weekly.js";
import { optimizeMonth } from "./roster-optimize.js";

const time = value => {
  const [hour, minute, second = 0] = value.split(":").map(Number);
  return hour * 60 + minute + second / 60;
};
export function interval(date, shift) {
  const start = time(shift.start), end = time(shift.end), base = dayIndex(date) * 1440;
  return [base + start, base + end + (end <= start ? 1440 : 0)];
}
const weekOffset = date => (weekday(date) + 6) % 7;
const lookup = catalog => new Map(catalog.map(shift => [shift.id, shift]));
const historySize = rules => Math.max(7, rules.maxRun, Math.ceil(rules.rest / 24) + 2);
function initialState(context, person, edges) {
  const date = context.dates[0], catalog = lookup(context.previousCatalog);
  const state = { run: 0, end: -Infinity, off: 0, unknown: 0, weekendOff: 0, work: 0, lastShift: "",
    streak: 0, best: 0, possible: 0, bestPossible: 0, mix: {}, phases: edges ? boundaryPhases(edges) : 127,
    cycleShift: "", monthShift: "", pairRun: 0, changed: false };
  for (let i = historySize(staffRules(context, person.id)); i > 0; i--) {
    const prior = dateAt(dayIndex(date) - i);
    const k = key(person.id, prior);
    const shift = catalog.get(context.previous[k] || (edges && context.leave[k]));
    state.run = shift?.kind === "work" ? state.run + 1 : 0;
    if (shift?.kind === "work") state.end = interval(prior, shift)[1];
    if (edges) {
      state.pairRun = shift?.kind === "off" ? state.pairRun + 1 : 0;
      if (!shift || state.pairRun === 2) state.cycleShift = "";
      if (shift?.kind === "work") {
        state.changed = Boolean(state.cycleShift && state.cycleShift !== shift.id);
        state.cycleShift = shift.id;
      }
    }
    if (i <= weekOffset(date)) {
      if (shift?.kind === "off") state.off++;
      if (!shift) state.unknown++;
      offStreak(state, shift);
    }
  }
  return state;
}
function offStreak(state, shift) {
  state.streak = shift?.kind === "off" ? state.streak + 1 : 0;
  state.possible = !shift || shift.kind === "off" ? state.possible + 1 : 0;
  state.best = Math.max(state.best, state.streak);
  state.bestPossible = Math.max(state.bestPossible, state.possible);
}
function advance(state, date, shift, rules) {
  const offset = weekOffset(date);
  const next = offset ? { ...state } : { ...state, off: 0, unknown: 0, streak: 0, best: 0, possible: 0, bestPossible: 0 };
  const problems = [];
  if (shift?.kind === "work") {
    const [start, end] = interval(date, shift);
    if (start - state.end < rules.rest * 60) problems.push("Insufficient rest between shifts");
    if (++next.run > rules.maxRun) problems.push("Too many consecutive workdays");
    if (rules.restrictRotation && state.monthShift && state.monthShift !== shift.id) problems.push("Shift rotation is restricted");
    next.lastShift = shift.id;
    next.monthShift = shift.id;
    next.mix = { ...state.mix, [shift.id]: (state.mix[shift.id] || 0) + 1 };
    next.end = end;
    next.work++;
  } else {
    next.run = 0;
    if (shift?.kind === "off") {
      next.off++;
      if (offset >= 5) next.weekendOff++;
    }
    if (!shift) next.unknown++;
  }
  offStreak(next, shift);
  if (rules.paired) {
    if (shift) next.phases &= phasesFor(date, shift.kind === "off");
    if (shift?.kind === "work" && state.cycleShift && shift.id !== state.cycleShift) {
      const adjacent = rules.transitions.some(([a, b]) => a === state.cycleShift && b === shift.id || b === state.cycleShift && a === shift.id);
      const onEve = next.phases & endingPhase(date);
      if (!adjacent || !onEve || state.changed) problems.push("Shift transition is not allowed before an OFF pair");
      next.phases = onEve;
      next.changed = true;
    }
    if (!next.phases) problems.push("Exactly two consecutive regular OFF days are required per seven-day cycle");
    next.pairRun = shift?.kind === "off" ? state.pairRun + 1 : 0;
    if (next.pairRun >= 2) { next.cycleShift = ""; next.changed = false; }
    else if (shift?.kind === "work") next.cycleShift = shift.id;
    else if (!shift) next.cycleShift = "";
  } else {
    if (next.off + next.unknown + (6 - offset) < rules.weeklyOff) problems.push("Weekly OFF minimum cannot be met");
    if (next.bestPossible < rules.consecutiveOff && next.possible + (6 - offset) < rules.consecutiveOff) {
      problems.push("Consecutive OFF requirement cannot be met");
    }
  }
  return { next, problems };
}
const rulesFor = (context, id) => ({ ...staffRules(context, id), paired: pairedPolicy(context), transitions: context.transitions || [] });
function generationScope(context, { group = "", people } = {}) {
  const selected = new Set(people || context.people.map(person => person.id));
  const groups = (group ? [group] : [...context.groups.map(g => g.id), "unassigned"])
    .filter(id => !people || context.people.some(person => person.group === id && selected.has(person.id)));
  return { selected, groups };
}
function coverageMatching(slots, limits) {
  const matched = [];
  const assign = (shift, seen) => slots.some((slot, i) => {
    if (seen.has(i) || !slot.codes.includes(shift)) return false;
    seen.add(i);
    if (matched[i] && !assign(matched[i], seen)) return false;
    matched[i] = shift;
    return true;
  });
  let count = 0;
  for (const { id, limit } of limits) {
    for (let i = 0; i < Math.min(limit, slots.length); i++) {
      if (!assign(id, new Set())) break;
      count++;
    }
  }
  return count;
}
function nextProblems(state, edges, rules) {
  const found = [];
  for (const { date, shift } of edges?.next || []) {
    const { next, problems } = advance(state, date, shift, { ...rules, restrictRotation: false });
    if (shift && problems.length) found.push({ date, problems });
    state = next;
  }
  return found;
}

export function validate(context, cells = context.draft.cells, scope = {}) {
  const errors = [], warnings = [], catalog = lookup(context.catalog);
  const put = (target, type, label, ref = {}) => target.push({ type, label, ...ref });
  for (const person of context.people) {
    if (scope.people && !scope.people.has(person.id)) continue;
    const rules = rulesFor(context, person.id), edges = rules.paired ? boundary(context, person.id) : null;
    if (person.group === "unassigned") put(warnings, "group", person.name + " is unassigned");
    if (context.conflicts?.includes(person.id)) put(errors, "group", person.name + " has conflicting group membership");
    let state = initialState(context, person, edges);
    const start = dayIndex(context.dates[0]);
    if (edges) {
      for (const [label, rows] of [["Previous", edges.previous], ["Next", edges.next]]) {
        if (rows.some(item => !item.shift)) put(warnings, "boundary", person.name + ": " + label +
          " month boundary incomplete; cross-month OFF and shift continuity are provisional.");
      }
      if (!state.phases) put(errors, "boundary", person.name + ": known month boundaries disagree on an OFF pair.", { cell: key(person.id, context.dates[0]) });
    } else if (Array.from({ length: historySize(rules) }, (_, i) => dateAt(start - 1 - i))
      .some(date => !context.previousCatalog.some(s => s.id === context.previous[key(person.id, date)]))) {
      put(warnings, "boundary", person.name + ": previous boundary incomplete; unknown dates are not assumed working or OFF");
    }
    for (const date of context.dates) {
      const k = key(person.id, date), value = cells[k], shift = catalog.get(value) || (!value && heldBlank(context, k) ? blankHoldShift : null);
      const label = person.name + " on " + date;
      const ref = { cell: k };
      if (Array.isArray(value)) put(errors, "duplicate", "Duplicate assignments: " + label, ref);
      else if (!value) put(errors, "missing", "Missing assignment: " + label, ref);
      else if (!shift) put(errors, "invalid", "Invalid shift: " + label, ref);
      if (context.leave[k] && value !== context.leave[k]) put(errors, "leave", "Confirmed leave conflict: " + label, ref);
      if (isLocked(context, person.id, date) && (context.draft.cells[k] || "") !== (value || "") && !context.leave[k]) {
        put(errors, "lock", "Locked assignment changed: " + label, ref);
      }
      if (shift && !eligible(rules, shift)) put(errors, "fixed", "Fixed shift or allowed-shift conflict: " + label, ref);
      const { next, problems } = advance(state, date, shift, rules);
      for (const problem of problems) put(errors, "rule", problem + ": " + label, ref);
      state = next;
    }
    const last = context.dates.at(-1);
    if (edges) for (const issue of nextProblems(state, edges, rules)) {
      for (const problem of issue.problems) put(errors, "boundary", person.name + " on next-month date " + issue.date + ": " + problem, { cell: key(person.id, last) });
    }
    if (!rules.paired && weekOffset(last) < 6 && state.off < rules.weeklyOff) {
      put(warnings, "boundary", person.name + ": " + (rules.weeklyOff - state.off) + " OFF day(s) still due in next month's opening week");
    }
    if (!rules.paired && weekOffset(last) < 6 && state.best < rules.consecutiveOff) {
      put(warnings, "boundary", person.name + ": consecutive OFF requirement carries into the next month.");
    }
  }
  for (const day of coverageReport(context, cells).daily) {
    if (scope.groups && !scope.groups.includes(day.group)) continue;
    if (pairedPolicy(context)) {
      const ref = { coverage: [day.group, day.date, "OFF"] };
      if (!validDemand(day.demand)) put(errors, "demand", day.name + " " + day.date + ": invalid workload or OFF settings", ref);
      if (day.demand.maxOff !== null && day.off > day.demand.maxOff) put(errors, "demand", day.name + " " + day.date + ": daily OFF cap exceeded", ref);
      if (day.working < day.demand.minWork) put(errors, "demand", day.name + " " + day.date + ": minimum working staff not met", ref);
    }
    for (const shift of day.shifts) {
      const label = day.name + " " + day.date + " " + shift.id, ref = { coverage: [day.group, day.date, shift.id] };
      if (!validCoverage(shift)) put(errors, "coverage", label + ": invalid coverage settings", ref);
      else if (shift.count < shift.min) put(errors, "coverage", label + ": " + shift.count + "/" + shift.min + " minimum", ref);
      else if (shift.max !== null && shift.count > shift.max) put(errors, "coverage", label + ": exceeds maximum " + shift.max, ref);
      else if (shift.count < shift.target) put(warnings, "target", label + ": " + shift.count + "/" + shift.target + " target", ref);
    }
  }
  return { errors, warnings };
}

export function diagnose(context, options = {}) {
  const { selected, groups } = generationScope(context, options);
  const catalog = lookup(context.catalog), shifts = context.catalog.filter(s => s.kind === "work");
  const issues = [], suggestions = new Map();
  const paired = pairedPolicy(context);
  const add = (code, reason, ref, current, available, action, certainty = "Confirmed") =>
    issues.push({ code, reason, ...ref, current, available, action, certainty });
  const refill = () => suggestions.set("refill", { id: "refill", current: "Fill empty cells only", proposed: "Regenerate unlocked assignments",
    effect: "Search can replace unlocked assignments. Locks and confirmed leave remain unchanged." });
  for (const person of context.people.filter(p => selected.has(p.id) && context.conflicts?.includes(p.id))) {
    add("membership", "Invalid or conflicting effective brand membership", { group: person.group, staff: person.name, setting: "groups" },
      person.group, "One valid brand in this team", "Review the effective transfer month and brand membership.");
  }
  for (const group of groups) {
    const people = context.people.filter(p => p.group === group);
    const days = [];
    const fixed = (p, date) => {
      const k = key(p.id, date), saved = context.draft.cells[k];
      return { saved, locked: isLocked(context, p.id, date), outside: !selected.has(p.id), leave: context.leave[k],
        retained: Boolean(!selected.has(p.id) || isLocked(context, p.id, date) || options.keepAssigned && saved) };
    };
    const masks = new Map();
    for (const p of people.filter(person => selected.has(person.id))) {
      const rules = rulesFor(context, p.id), edges = paired ? boundary(context, p.id) : null;
      let state = initialState(context, p, edges);
      if (edges && !state.phases) add("boundary-pair", "Known adjacent-month assignments rule out all regular OFF pairs",
        { group, staff: p.name, date: context.dates[0], cell: key(p.id, context.dates[0]) },
        "Previous and next month assignments", "One consistent two-day OFF pair", "Review the adjacent-month assignments.");
      if (edges && [...edges.previous, ...edges.next].some(row => !row.shift)) {
        add("boundary", "Cross-month OFF and shift continuity are provisional", { group, staff: p.name, date: context.dates[0], cell: key(p.id, context.dates[0]) },
          "Adjacent month incomplete", "Only recorded dates constrain the search", "Review known boundary assignments.", "Unknown");
      }
      for (const date of context.dates) {
        const k = key(p.id, date), { saved, locked, retained, leave } = fixed(p, date);
        const shift = catalog.get(leave || (retained ? saved : "")) || (heldBlank(context, k) ? blankHoldShift : null);
        const ref = { group, date, staff: p.name, cell: k, shift: shift?.id };
        if (shift === blankHoldShift) add("held-empty", "Approved leave override keeps this cell intentionally unassigned", ref,
          "Unassigned", "An assignment is required for confirmation", "Use Override Approved Leave to assign a shift or leave on this date.");
        if (leave && saved && saved !== leave || locked && !shift) {
          add(leave ? "leave" : "lock", leave ? "Confirmed leave conflicts with the saved cell" : "Locked cell has no valid shift",
            ref, String(saved || "Blank"), leave || "A valid locked assignment", "Review the original assignment; confirmed leave and locks will not be changed automatically.");
        } else if (retained && saved && !shift) {
          add("assignment", "Retained cell has an invalid shift", ref, String(saved), "A shift in this team catalog", "Correct the assignment.");
        }
        if (shift && !eligible(rules, shift)) add("eligibility", "Retained shift is not eligible for this staff member",
          { ...ref, setting: "staff" }, shift.id, rules.fixed || rules.allowed?.join(", "), "Review staff shift eligibility or the retained cell.");
        const step = advance(state, date, shift, rules);
        for (const problem of step.problems) {
          if (!state.phases && problem.startsWith("Exactly")) continue;
          // A blank between known shifts can change cycle continuity, but cannot add rest.
          add("retained-policy", problem, ref, shift?.id || "Blank", "Current mandatory roster rules",
            "Review retained cells, leave and adjacent-month assignments.");
          if (options.keepAssigned && retained && !locked && !leave) refill();
        }
        state = step.next;
      }
      for (const { date, problems } of nextProblems(state, edges, rules)) for (const reason of problems) {
        if (!state.phases && reason.startsWith("Exactly")) continue;
        add("boundary-policy", reason, { group, staff: p.name, date, cell: key(p.id, context.dates.at(-1)) },
          "Known next-month assignment", "Current mandatory roster rules", "Review the next month's saved assignments.");
      }
      if (paired) {
        masks.set(p.id, state.phases);
        if (!state.phases && options.keepAssigned && context.dates.some(date => {
          const slot = fixed(p, date);
          return slot.saved && !slot.locked && !slot.leave;
        })) refill();
      }
    }
    for (const date of context.dates) {
      const rule = demandRule(context, group, date), settings = shifts.map(shift => coverageRule(context, group, date, shift.id));
      const slots = people.map(p => {
        const entry = fixed(p, date), mask = masks.get(p.id);
        const codes = entry.leave && !entry.outside ? [] : entry.retained ? [entry.saved] :
          mask && !(mask & phasesFor(date, false)) ? [] :
          shifts.filter((s, i) => settings[i].enabled && eligible(staffRules(context, p.id), s)).map(s => s.id);
        const mandatoryOff = entry.retained ? entry.saved === "OFF" : mask && !(mask & phasesFor(date, false));
        return { codes, mandatoryOff, retained: entry.retained, replaceable: entry.retained && !entry.outside && !entry.locked && !entry.leave };
      });
      const available = slots.filter(slot => slot.codes.some(code => shifts.some(s => s.id === code))).length;
      const min = settings.reduce((sum, entry) => sum + entry.min, 0);
      const off = slots.filter(s => s.mandatoryOff).length;
      const ref = { group, date, setting: "demand", coverage: [group, date, "OFF"] };
      const cap = offCapacity(rule, people.filter(p => !protectedNonWork(context, key(p.id, date))).length, min);
      const valid = settings.every(validCoverage) && (!paired || validDemand(rule));
      const permitted = valid ? coverageMatching(slots, shifts.map((s, i) => ({ id: s.id, limit: settings[i].max ?? available }))) : available;
      const leave = people.filter(p => selected.has(p.id) && (() => {
        const entry = fixed(p, date);
        return entry.leave || entry.retained && catalog.get(entry.saved)?.kind === "leave";
      })()).length;
      const holds = people.filter(p => selected.has(p.id) && heldBlank(context, key(p.id, date))).length;
      const outsideWork = people.filter(p => !selected.has(p.id) && catalog.get(context.draft.cells[key(p.id, date)])?.kind === "work").length;
      const floor = Math.max(min, rulesMinimum(paired, rule));
      days.push({ date, cap, permitted, floor, leave, holds, outsideWork, valid });
      if (valid && floor > permitted && permitted < available) add("daily-work-capacity",
        "Shift caps and eligibility permit fewer assignments than the daily minimum",
        { group, date, setting: "coverage" }, floor + " required", permitted + " permitted (" + available + " potentially available)",
        "Review the effective strict maximums and eligible shifts; a flexible target does not limit assignments.");
      if (paired && !validDemand(rule)) add("demand", "Invalid daily OFF or working rule", ref,
        "OFF cap " + (rule.maxOff ?? "unlimited") + " / preferred " + (rule.preferredOff ?? "auto") + " / work minimum " + rule.minWork,
        "Nonnegative whole numbers; preferred OFF cannot exceed the cap", "Review Weekly Demand & OFF Planning.");
      if (paired && Number.isInteger(rule.maxOff) && rule.maxOff >= 0 && rule.preferredOff > rule.maxOff) {
        const id = group + "|" + date + "|preferredOff";
        suggestions.set(id, { id, group, date, shift: "OFF", field: "preferredOff", value: rule.maxOff,
          current: rule.preferredOff, proposed: rule.maxOff, effect: "Fit preferred OFF within the daily cap; mandatory settings remain unchanged." });
      }
      if (paired && rule.maxOff !== null && off > rule.maxOff) add("off-cap", "Required OFF assignments exceed the daily OFF cap", ref,
        rule.maxOff, off + " required OFF", "Review retained assignments or explicitly edit the daily OFF cap.");
      if (min > available || paired && rule.minWork > available) add("staffing", "Working minimum exceeds available staff",
        min >= rule.minWork ? { ...ref, setting: "coverage", coverage: [group, date, shifts[0]?.id || ""] } : ref,
        Math.max(min, rulesMinimum(paired, rule)), available, "Review eligibility, fixed cells, leave and brand allocation before changing minimums.");
      const requirements = shifts.map((s, i) => ({ id: s.id, min: settings[i].min }));
      if (min && min <= available && settings.every(validCoverage) &&
        requirements.every(s => slots.filter(slot => slot.codes.includes(s.id)).length >= s.min) &&
        coverageMatching(slots, requirements.map(s => ({ id: s.id, limit: s.min }))) < min) {
        add("overlapping-eligibility", "Shift minimums compete for the same eligible staff",
          { ...ref, setting: "coverage", coverage: [group, date, ""], shift: requirements.filter(s => s.min).map(s => s.id).join(", ") },
          min + " minimum assignments", available + " possible workers, but no distinct eligible match",
          "Review staff eligibility or fixed assignments; one person cannot cover two shifts on the same day.");
      }
      shifts.forEach((shift, i) => {
        const s = settings[i], shiftRef = { group, date, shift: shift.id, setting: "coverage", coverage: [group, date, shift.id] };
        const possible = slots.filter(slot => slot.codes.includes(shift.id)).length;
        const fixedCount = slots.filter(slot => slot.retained && slot.codes.includes(shift.id)).length;
        const propose = (field, value, effect) => {
          const id = coverageKey(group, date, shift.id) + "|" + field;
          suggestions.set(id, { id, group, date, shift: shift.id, field, value, current: s[field], proposed: value, effect });
        };
        if (!validCoverage(s)) {
          add("coverage-rule", "Invalid shift minimum, target, maximum or priority", shiftRef,
            s.min + " / " + s.target + " / " + (s.max ?? "unlimited"), "Minimum <= target <= maximum", "Review the effective coverage override.");
          if (s.enabled && Number.isInteger(s.max) && s.max >= s.min && s.target > s.max) propose("target", s.max, "Bring the optional target within the configured cap; minimum unchanged.");
        } else if (s.min > possible) add("eligible-coverage", "Too few eligible staff for the shift minimum", shiftRef, s.min, possible,
          "Review shift eligibility, fixed assignments or brand allocation.");
        else if (s.target > possible) {
          add("target", "Optional target exceeds eligible staff", shiftRef, s.target, possible, "Review optional target or eligibility.", "Preference");
          propose("target", possible, "Align the target with the number of eligible staff. Minimum unchanged; coverage is not guaranteed.");
        }
        if (s.max !== null && fixedCount > s.max) {
          add("shift-cap", "Retained assignments exceed the shift maximum", shiftRef, s.max, fixedCount,
            "Review this date's coverage override or regenerate unlocked assignments.");
          if (validCoverage(s)) propose("max", fixedCount, "Allow the retained assignments on this date; minimum and target unchanged.");
          if (options.keepAssigned && slots.some(slot => slot.replaceable && slot.codes.includes(shift.id))) refill();
        }
      });
    }
    const selectedCount = people.filter(p => selected.has(p.id)).length;
    if (paired && selectedCount) for (let i = 0; i + 6 < days.length; i++) {
      const week = days.slice(i, i + 7), capacity = week.reduce((sum, day) => sum + day.cap, 0);
      if (selectedCount === people.length && capacity < people.length * 2) add("weekly-capacity", "Weekly capacity cannot accommodate two regular OFF days per staff member",
        { group, date: week[0].date, end: week.at(-1).date, setting: "demand" }, people.length * 2, capacity,
        "Review daily OFF caps, working minimums, leave and shift coverage.");
      if (!week.every(day => day.valid)) continue;
      const sum = field => week.reduce((total, day) => total + day[field], 0);
      const leave = sum("leave"), holds = sum("holds"), outside = sum("outsideWork"), required = selectedCount * 5 - leave - holds + outside;
      const permitted = sum("permitted"), floor = sum("floor");
      const ref = { group, date: week[0].date, end: week.at(-1).date, setting: "coverage" };
      if (permitted < required) add("weekly-work-capacity", "Weekly shift capacity contradicts paired OFF and required workdays", ref,
        required + " working slots (" + selectedCount * 5 + " before " + leave + " leave / " +
          (holds ? holds + " unassigned override(s) / " : "") + outside + " out-of-scope assignments)",
        permitted + " permitted at most under caps, eligibility and retained cells",
        "Test a coverage adjustment. Regular OFF days, leave, locks and shift eligibility stay unchanged.");
      if (floor > required) add("weekly-minimum-capacity", "Weekly minimum coverage exceeds the available working assignments", ref,
        floor + " required by coverage", required + " available with paired OFF and retained leave",
        "Review minimums or brand staffing; raising caps alone cannot add working days.");
    }
  }
  return { issues, suggestions: [...suggestions.values()], people: selected, groups };
}
const rulesMinimum = (paired, rule) => paired ? rule.minWork : 0;

export function adjustmentTrial(context, options, suggestions) {
  const trial = structuredClone(context), next = { ...options };
  delete next.witness;
  if (suggestions.length === 1 && suggestions[0].witness) next.witness = suggestions[0].witness;
  for (const item of suggestions.flatMap(item => item.changes || [item])) {
    if (item.id === "refill") next.keepAssigned = false;
    else if (item.field === "offPair" || item.field === "preferred") {
      trial.draft.preferences[item.person] = { ...trial.draft.preferences[item.person], [item.field]: item.value };
    } else if (item.field === "preferredOff" || item.field === "minWork") {
      trial.draft.demand[item.group + "|" + item.date] = {
        ...demandRule(trial, item.group, item.date), [item.field]: item.value
      };
    } else {
      const k = coverageKey(item.group, item.date, item.shift);
      const rule = coverageRule(trial, item.group, item.date, item.shift);
      trial.draft.coverage[k] = { ...rule, ...(item.rule || { [item.field]: item.value }) };
    }
  }
  return { context: trial, options: next };
}

export function candidateMetrics(context, cells, scopePeople, scopeGroups, checked = validate(context, cells, {
  people: new Set(scopePeople), groups: scopeGroups
})) {
  const report = coverageReport(context, cells), people = report.staff.filter(p => scopePeople.includes(p.id));
  const days = report.daily.filter(day => scopeGroups.includes(day.group)), shortages = [], overflow = [];
  let needed = 0, met = 0, pm = 0, work = 0;
  for (const day of days) {
    pm += day.counts.PM || 0; work += day.working;
    const list = [
      ...day.shifts.map(s => ({ shift: s.id, required: s.min, actual: s.count, maximum: s.max })),
      { shift: "Working staff", required: day.demand.minWork, actual: day.working, maximum: null },
      { shift: "OFF", required: 0, actual: day.off, maximum: day.demand.maxOff }
    ];
    for (const item of list) {
      needed += item.required; met += Math.min(item.actual, item.required);
      const row = { ...item, group: day.group, name: day.name, date: day.date };
      if (item.actual < item.required) shortages.push(row);
      if (item.maximum !== null && item.actual > item.maximum) overflow.push(row);
    }
  }
  const expected = scopePeople.length * context.dates.length;
  const assigned = people.reduce((n, p) => n + p.work + p.off + p.leave, 0);
  const leave = Object.entries(context.leave).filter(([k]) => {
    const [id, date] = k.split("|");
    return scopePeople.includes(id) && context.dates.includes(date);
  });
  return { report, people, shortages, overflow, assigned, expected, completion: expected ? 100 * assigned / expected : 0,
    coverage: needed ? 100 * met / needed : 100, shortfall: needed - met,
    met, needed,
    excess: overflow.reduce((n, row) => n + row.actual - row.maximum, 0),
    paired: people.reduce((n, p) => n + p.compliant, 0), windows: people.reduce((n, p) => n + p.weeks, 0),
    pm, work, fairness: people.length ? Math.max(...people.map(p => p.work)) - Math.min(...people.map(p => p.work)) : 0,
    leaveMet: leave.filter(([k, value]) => cells[k] === value).length, leaveTotal: leave.length,
    blockers: checked.errors.length, staffBlockers: checked.errors.filter(e => !["coverage", "demand"].includes(e.type)).length };
}

const monthConstraints = { rulesFor, initialState, advance, nextProblems };
const candidateOrder = (a, b) => a.metrics.staffBlockers - b.metrics.staffBlockers ||
  (a.metrics.shortfall + a.metrics.excess) - (b.metrics.shortfall + b.metrics.excess) || a.metrics.blockers - b.metrics.blockers;
const stats = ({ assigned, expected, completion, coverage, shortfall, excess, blockers, staffBlockers, paired, windows, pm, work, fairness, met, needed,
  leaveMet, leaveTotal }) =>
  ({ assigned, expected, completion, coverage, shortfall, excess, blockers, staffBlockers, paired, windows, pm, work, fairness, met, needed,
    leaveMet, leaveTotal });
const impact = (best, candidate) => ({
  before: stats(best.metrics), after: stats(candidate.metrics),
  outcome: candidate.status === "feasible" ? "Resolves in this trial" :
    candidateOrder(candidate, best) < 0 || candidate.metrics.assigned > best.metrics.assigned ? "Improves in this trial" : "No improvement alone"
});

function coveragePackages(context, best, issues, run) {
  const affected = new Set([
    ...best.metrics.overflow.filter(row => row.shift !== "OFF").map(row => row.group),
    ...issues.filter(i => ["weekly-work-capacity", "daily-work-capacity"].includes(i.code)).map(i => i.group)
  ]);
  if (!affected.size) return [];
  const caps = best.report.daily.filter(day => affected.has(day.group)).flatMap(day => day.shifts
    .filter(s => s.enabled && Number.isInteger(s.max) && s.max >= 0 && validCoverage(s)).map(s => ({
      group: day.group, date: day.date, shift: s.id, previous: { target: s.target, max: s.max },
      rule: { target: Math.max(s.min, s.target, s.max), max: null }
    })));
  if (!caps.length) return [];
  const converted = { id: "flexible-caps", title: "Convert strict caps to flexible targets", changes: caps,
    effect: "Treat the affected caps as targets. Minimums, eligible shifts, leave, locks and OFF rules still apply." };
  const relaxed = run(converted);
  if (!relaxed) return [];
  const counts = new Map(relaxed.report.daily.map(day => [day.group + "|" + day.date, day.counts]));
  const changes = caps.flatMap(item => {
    const assigned = counts.get(item.group + "|" + item.date)?.[item.shift] || 0;
    return assigned > item.previous.max ? [{ ...item, rule: { target: assigned, max: assigned } }] : [];
  });
  const auto = { id: "optimize-caps", title: "Raise only the caps the optimized roster needs", changes, witness: relaxed.cells,
    effect: "Uses the generated month to set new caps and targets on affected dates only. It does not lower minimums." };
  const bounded = changes.length && run(auto);
  return [...(bounded ? [{ ...auto, impact: impact(best, bounded) }] : []), { ...converted, impact: impact(best, relaxed) }];
}

function preferenceOptions(context, candidate, options, run) {
  const row = candidate.metrics.shortages.find(item => item.shift !== "Working staff");
  if (!row) return [];
  const shift = context.catalog.find(s => s.id === row.shift);
  const members = context.people.filter(p => p.group === row.group && candidate.scopePeople.includes(p.id) &&
    eligible(staffRules(context, p.id), shift) && !isLocked(context, p.id, row.date) &&
    !(options.keepAssigned && context.draft.cells[key(p.id, row.date)]));
  const proposals = [];
  const off = members.find(p => context.catalog.some(s => s.kind === "off" && s.id === candidate.cells[key(p.id, row.date)]));
  if (off) {
    const weekdayAt = weekday(row.date);
    const weekStart = dayIndex(row.date) - weekdayAt;
    const pair = pairNames.map((_, n) => n).filter(n => n !== weekdayAt && (n + 1) % 7 !== weekdayAt)
      .sort((a, b) => {
        const weight = n => [n, (n + 1) % 7].reduce((sum, day) =>
          sum + workloads.indexOf(demandRule(context, row.group, dateAt(weekStart + day)).workload), 0);
        return weight(b) - weight(a);
      })[0];
    const prior = context.draft.preferences[off.id]?.offPair;
    if (pair !== prior) proposals.push({ id: "prefer-off|" + off.id, person: off.id, staff: off.name, group: row.group,
      date: row.date, shift: "OFF", field: "offPair", value: pair, current: pairNames[prior] || "No preferred pair", proposed: pairNames[pair],
      effect: "Prefers a quieter OFF pair without changing entitlement or locking new OFF dates." });
  }
  const worker = members.find(p => context.catalog.some(s => s.kind === "work" && s.id !== row.shift &&
    s.id === candidate.cells[key(p.id, row.date)]) && staffRules(context, p.id).preferred !== row.shift);
  if (worker) proposals.push({ id: "prefer-shift|" + worker.id, person: worker.id, staff: worker.name, group: row.group,
    date: row.date, shift: row.shift, field: "preferred", value: row.shift,
    current: staffRules(context, worker.id).preferred || "No preferred shift", proposed: row.shift,
    effect: "Changes a soft shift preference only; eligibility and the required rest between shifts stay enforced." });
  return proposals.flatMap(item => {
    const trial = run(item);
    if (!trial) return [];
    const measured = impact(candidate, trial);
    return measured.outcome === "No improvement alone" ? [] : [{ ...item, impact: measured }];
  });
}

function generateMonthly(context, options, progress, check = diagnose(context, options)) {
  const { selected, groups } = generationScope(context, options);
  const scopePeople = context.people.filter(p => groups.includes(p.group) && selected.has(p.id)).map(p => p.id);
  if (!scopePeople.length) return { status: "infeasible", reason: "No staff in this generation scope.", issues: check.issues, suggestions: [] };
  const mode = options.strategy || (context.team === "Affiliate" ? "pm" : "balanced");
  const primary = mode === "custom" ? "demand" : mode;
  const profiles = options.trial ? [primary] : [primary, ...["balanced", "pm", "demand"].filter(profile => profile !== primary)];
  const { candidates: plans, impossible } = optimizeMonth(context, options, { selected, groups }, monthConstraints, profiles, progress);
  if (options.witness) {
    const cells = { ...context.draft.cells };
    for (const id of scopePeople) for (const date of context.dates) {
      const k = key(id, date);
      if (!(options.keepAssigned && cells[k])) cells[k] = options.witness[k];
    }
    const checked = validate(context, cells, { people: new Set(scopePeople), groups });
    if (!checked.errors.length) plans.push({ cells, variant: plans.length, profile: "Tested coverage plan" });
  }
  const seen = new Set();
  const candidates = plans.map(plan => {
    const scope = { people: new Set(scopePeople), groups }, checked = validate(context, plan.cells, scope);
    const metrics = candidateMetrics(context, plan.cells, scopePeople, groups, checked);
    return { ...plan, metrics, report: metrics.report, scopePeople, scopeGroups: groups, selectedCount: scopePeople.length,
      completed: metrics.assigned, warnings: checked.warnings, errors: checked.errors,
      status: checked.errors.length ? "provisional" : "feasible",
      target: metrics.report.daily.filter(day => groups.includes(day.group)).flatMap(day => day.shifts)
        .reduce((sum, s) => sum + Math.min(s.count, s.target) * (1 + s.priority), 0) };
  }).sort(candidateOrder).filter(plan => {
    const signature = JSON.stringify(plan.cells);
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  }).slice(0, 3);
  const feasible = candidates.some(plan => plan.status === "feasible");
  const issues = [...check.issues];
  for (const { person, group } of impossible) {
    issues.push({ code: "staff-pattern", certainty: "Confirmed", reason: "No legal month pattern for this staff member",
      group, staff: person.name, date: context.dates[0], end: context.dates.at(-1), setting: "staff",
      cell: key(person.id, context.dates[0]), current: "Retained assignments, leave, eligibility and boundary settings",
      available: "Zero compatible staff patterns", action: "Inspect the retained dates and effective coverage override. Do not change a lock or confirmed leave to force a result." });
  }
  const confirmed = issues.some(issue => issue.certainty === "Confirmed");
  const result = { status: feasible ? "feasible" : confirmed ? "infeasible" : "timeout",
    feasibility: feasible ? "Confirmed feasible" : confirmed ? "Disproven under current settings" : "Unknown (no valid plan found)",
    reason: feasible ? "" : "The monthly optimizer found no fully valid plan under the current settings.", candidates, issues, suggestions: [] };
  if (options.trial || feasible || !candidates.length) return result;
  const best = candidates[0];
  const run = item => {
    const trial = adjustmentTrial(context, { ...options, retry: false, trial: true }, [item]);
    return generateMonthly(trial.context, trial.options).candidates?.[0];
  };
  const proposals = new Map(check.suggestions.map(s => [s.id, s]));
  const pushCoverage = (row, field, value, effect) => {
    const id = coverageKey(row.group, row.date, row.shift) + "|" + field;
    if (value <= 99) proposals.set(id, { id, group: row.group, date: row.date, shift: row.shift, field, value,
      current: field === "min" ? row.required : row.maximum, proposed: value, effect });
  };
  for (const row of best.metrics.overflow) if (!["OFF", "Working staff"].includes(row.shift)) {
    pushCoverage(row, "max", row.actual, "Raises the explicit cap on this date only; review the staffing impact before approving.");
  }
  // An explicit coverage reduction is never automatic and is shown only after an isolated trial.
  const firstShortages = best.metrics.shortages.filter(row => row.shift !== "Working staff");
  const workShortage = best.metrics.shortages.find(row => row.shift === "Working staff");
  if (workShortage) {
    const { group, date, actual, required } = workShortage;
    const id = group + "|" + date + "|minWork";
    proposals.set(id, { id, group, date, shift: "Working staff", field: "minWork", value: actual,
      current: required, proposed: actual, effect: "Lowers only this date's working-staff requirement; shift minimums remain unchanged." });
  }
  for (const row of firstShortages.slice(0, 2)) pushCoverage(row, "min", row.actual,
    "Lowers the required staffing on this date only. This changes a coverage requirement, not the number of available staff.");
  if (options.keepAssigned && context.people.some(p => scopePeople.includes(p.id) && context.dates.some(date =>
    context.draft.cells[key(p.id, date)] && !isLocked(context, p.id, date)))) proposals.set("refill", {
    id: "refill", current: "Fill empty cells only", proposed: "Regenerate unlocked assignments",
    effect: "Replan unlocked assignments. Locks and confirmed leave remain unchanged."
  });
  const pool = [...proposals.values()];
  const tested = pool.length <= 5 ? pool : [...pool.slice(0, 4), pool.at(-1)];
  for (const item of tested) {
    const candidate = run(item);
    if (!candidate) continue;
    result.suggestions.push({ ...item, impact: impact(best, candidate) });
  }
  result.suggestions.unshift(...coveragePackages(context, best, issues, run));
  result.suggestions.push(...preferenceOptions(context, best, options, run));
  return result;
}

export function generate(context, { group = "", people: staffIds, keepAssigned = false, budget = 180000, timeout = 3500,
  strategy = context.team === "Affiliate" ? "pm" : "balanced", variant = 0, progress, recover = false } = {}) {
  const cells = { ...context.draft.cells }, rules = context.draft.rules;
  const shifts = context.catalog.filter(s => s.kind === "work");
  const off = context.catalog.find(s => s.kind === "off"), catalog = lookup(context.catalog);
  const { selected, groups } = generationScope(context, { group, people: staffIds });
  const priorDates = datesFor(previousMonth(context.month));
  const deadline = performance.now() + timeout;
  let steps = 0, stopped = false, deepest = -1, reason = "";
  const scopePeople = context.people.filter(person => groups.includes(person.group) && selected.has(person.id)).map(p => p.id);
  if (!off || context.conflicts?.some(id => scopePeople.includes(id)) || !scopePeople.length) return {
    status: "infeasible", reason: "Resolve invalid catalog, scope, or group membership first."
  };
  if (strategy === "previous" && !Object.keys(context.previous).length) {
    return { status: "missing-boundary", reason: "No previous-month draft or snapshot is available. Choose another strategy or prepare the previous month." };
  }
  let best, completed = 0;
  const observations = new Map();
  for (const [groupIndex, id] of groups.entries()) {
    const people = context.people.filter(p => p.group === id);
    const config = context.dates.map(date => shifts.map(s => coverageRule(context, id, date, s.id)));
    const paired = pairedPolicy(context);
    const preferences = people.map(person => rulesFor(context, person.id));
    const selectedCount = people.filter(person => selected.has(person.id)).length;
    const edges = people.map(person => paired ? boundary(context, person.id) : null);
    const states = people.map((person, i) => initialState(context, person, edges[i]));
    const demands = context.dates.map((date, i) => {
      const rule = demandRule(context, id, date);
      const available = people.filter(person => !protectedNonWork(context, key(person.id, date))).length;
      const cap = offCapacity(rule, available, config[i].reduce((sum, entry) => sum + entry.min, 0));
      return { rule, available, cap };
    });
    for (const [index, date] of context.dates.entries()) {
      const name = context.groups.find(g => g.id === id)?.name || "Unassigned";
      const limits = config[index];
      if (limits.some(rule => !validCoverage(rule))) return { status: "infeasible", code: "coverage",
        reason: name + " has an invalid minimum, target, maximum or priority on " + date };
      const available = people.filter(person => !protectedNonWork(context, key(person.id, date))).length;
      if (limits.reduce((n, rule) => n + rule.min, 0) > available) return { status: "infeasible", code: "staffing",
        reason: name + ": minimum coverage exceeds available staff on " + date + ". Review minimums, eligibility or a manual transfer." };
      if (paired && (!validDemand(demands[index].rule) || demands[index].rule.minWork > available)) return {
        status: "infeasible", code: "demand", reason: name + ": check daily OFF limits and available working staff on " + date
      };
      for (const person of people) {
        const k = key(person.id, date), value = cells[k];
        if (context.leave[k] && value && context.leave[k] !== value) return { status: "infeasible", code: "leave",
          reason: "Confirmed leave conflicts with " + person.name + "'s assignment on " + date };
        if (!context.leave[k] && selected.has(person.id) && isLocked(context, person.id, date) && !catalog.has(value) && !heldBlank(context, k)) {
          return { status: "infeasible", code: "locked", reason: person.name + " has a blank or invalid locked assignment on " + date };
        }
      }
    }
    if (paired) {
      for (const [n, person] of people.entries()) {
        if (!selected.has(person.id)) continue;
        for (const date of context.dates) {
          const k = key(person.id, date), code = cells[k];
          if (context.leave[k]) states[n].phases &= phasesFor(date, false);
          else if (isLocked(context, person.id, date) || keepAssigned && code) {
            const shift = catalog.get(code) || (heldBlank(context, k) ? blankHoldShift : null);
            if (shift) states[n].phases &= phasesFor(date, shift.kind === "off");
          }
        }
        if (!states[n].phases) return { status: "infeasible", code: "off-pair",
          reason: person.name + ": confirmed leave, immutable cells or known boundaries rule out every consecutive OFF pair." };
      }
      if (people.every(person => selected.has(person.id))) {
        for (let i = 0; i + 6 < context.dates.length; i++) {
          if (demands.slice(i, i + 7).reduce((sum, d) => sum + d.cap, 0) < people.length * 2) return {
            status: "infeasible", code: "off-capacity", reason: nameFor(id) + " " + context.dates[i] + " to " +
              context.dates[i + 6] + ": weekly OFF capacity is below " + people.length * 2 +
              ". Review OFF caps, working minimums or coverage requirements."
          };
        }
      }
    }
    deepest = -1;
    reason = "";
    function nameFor(groupId) { return context.groups.find(g => g.id === groupId)?.name || "Unassigned"; }
    const track = (index, message, details = {}) => {
      if (index >= deepest) { deepest = index; reason = (context.groups.find(g => g.id === id)?.name || "Unassigned") +
        " on " + context.dates[index] + ": " + message; }
      const k = id + "|" + message;
      const previous = observations.get(k);
      if (!previous || index >= previous.index) observations.set(k, { index, issue: { code: "search", certainty: "Observed branch",
        reason: message, group: id, date: context.dates[index], action: "Review the settings shown or retry with a wider search.", ...details } });
    };
    function solveDay(index, states) {
      if (recover && index > 0 && completed + index * selectedCount > (best?.completed || 0)) {
        const partial = { ...context.draft.cells };
        for (const candidate of context.people) {
          const depth = candidate.group === id ? index : groups.indexOf(candidate.group) >= 0 && groups.indexOf(candidate.group) < groupIndex ?
            context.dates.length : 0;
          if (selected.has(candidate.id)) for (const date of context.dates.slice(0, depth)) {
            const k = key(candidate.id, date);
            if (cells[k]) partial[k] = cells[k];
          }
        }
        best = { cells: partial, completed: completed + index * selectedCount, scopePeople, scopeGroups: groups };
      }
      if (index === context.dates.length) {
        for (const [n, person] of people.entries()) {
          if (!selected.has(person.id)) continue;
          const issue = nextProblems(states[n], edges[n], preferences[n])[0];
          if (issue) { track(index - 1, person.name + " / next-month " + issue.date + ": " + issue.problems[0]); return false; }
        }
        return true;
      }
      const date = context.dates[index], settings = config[index];
      const demand = demands[index];
      const options = people.map((person, n) => {
        const k = key(person.id, date), saved = context.draft.cells[k], pref = preferences[n];
        const leave = context.leave[k], locked = isLocked(context, person.id, date);
        const outside = !selected.has(person.id);
        const choices = outside ? [catalog.get(saved)] : leave ? [catalog.get(leave)] : locked || (keepAssigned && saved) ?
          [catalog.get(saved) || (heldBlank(context, k) ? blankHoldShift : null)] :
          [off, ...shifts.filter((s, i) => settings[i].enabled && eligible(pref, s))];
        return { n, k, outside, choices: choices.filter(s => outside || s && eligible(pref, s)).map(shift => ({
          shift, ...(outside ? { next: states[n] } : advance(states[n], date, shift, pref))
        })).filter(option => !option.problems?.length) };
      }).sort((a, b) => a.choices.length - b.choices.length ||
        states[b.n].work - states[a.n].work || ((a.n + index) % people.length) - ((b.n + index) % people.length));
      if (options.some(entry => !entry.choices.length)) {
        const entry = options.find(item => !item.choices.length);
        track(index, "No eligible assignment remains for this staff member in this search branch",
          { staff: people[entry.n].name, cell: entry.k, current: context.draft.cells[entry.k] || "Blank", available: 0 });
        return false;
      }
      const counts = shifts.map(() => 0), next = [];
      let assignedOff = 0, working = 0;
      function assign(i) {
        if (++steps > budget || (steps % 64 === 0 && performance.now() >= deadline)) { stopped = true; return false; }
        if (steps % 4096 === 0) progress?.({ steps, date, group: id });
        const remaining = options.slice(i);
        for (const [n, rule] of settings.entries()) {
          const needed = rule.min - counts[n];
          const shift = shifts[n].id, ref = { shift, setting: "coverage", coverage: [id, date, shift] };
          const possible = needed > 0 ? remaining.filter(entry => entry.choices.some(c => c.shift?.id === shift)).length : 0;
          if (needed > 0 && possible < needed) {
            track(index, shift + " coverage cannot be met with eligible staff", { ...ref, current: rule.min, available: counts[n] + possible });
            return false;
          }
          if (rule.max !== null) {
            const forced = counts[n] + remaining.filter(entry => entry.choices.every(c => c.shift?.id === shift)).length;
            if (forced > rule.max) {
              track(index, shift + " maximum pruned a search branch", { ...ref, current: rule.max, available: forced + " forced on this branch" });
              return false;
            }
          }
        }
        if (paired && demand.rule.minWork > working && working + remaining.filter(entry => entry.choices.some(c => c.shift?.kind === "work")).length < demand.rule.minWork) {
          track(index, "minimum working staff cannot be met with available assignments");
          return false;
        }
        if (i === options.length) return solveDay(index + 1, next);
        const entry = options[i], state = states[entry.n], offset = weekOffset(date), pref = preferences[entry.n];
        const preferred = (entry.n + variant + (pref.rotate ? Math.floor(index / 7) : 0)) % Math.max(1, shifts.length);
        const prior = priorDates[index] && context.previous[key(people[entry.n].id, priorDates[index])];
        function rank(choice) {
          if (!choice.shift) return 0;
          const n = shifts.indexOf(choice.shift);
          if (n >= 0 && counts[n] < settings[n].min) return 1000 + settings[n].priority;
          const pattern = strategy === "previous" && choice.shift.id === prior ? 30 : 0;
          if (paired && choice.shift.kind === "off") {
            const chosen = phaseIndices(choice.next.phases);
            const prefBonus = (chosen.includes(pref.offPair) ? 9 : 0) + (pref.offDays?.includes(weekdays[weekday(date)]) ? 5 : 0);
            const offset = (entry.n + variant) % 7;
            const stagger = rules.fair && chosen.includes(offset) ? 6 : 0;
            const target = desiredOff(demand.rule, demand.available);
            return 35 + pattern + prefBonus + stagger + (assignedOff < target ? 48 : -95);
          }
          if (choice.shift.kind === "off") {
            const due = Math.max(0, pref.weeklyOff - (offset ? state.off : 0));
            const preferredRun = pref.preferredOffRun ?? (pref.preferConsecutiveOff ? 2 : 0);
            const continueOff = offset > 0 && state.streak > 0 && state.streak < preferredRun;
            if (!due) return (continueOff ? 15 : -20) + pattern;
            if (!rules.fair) return 80 + pattern;
            const phase = (entry.n + variant + 2 * Math.floor((index + weekOffset(context.dates[0])) / 7)) % 7;
            const preferredOff = Array.from({ length: pref.weeklyOff }, (_, i) => (phase + Math.floor(i * 7 / pref.weeklyOff)) % 7);
            const wantsOff = preferredOff.includes(offset) || pref.offDays?.includes(weekdays[weekday(date)]) ||
              continueOff;
            return (wantsOff ? 90 - (offset >= 5 ? state.weekendOff : 0) : -10) + pattern;
          }
          if (n < 0) return 0;
          const rule = settings[n], target = counts[n] < rule.target ? 16 + rule.priority * 4 : 0;
          const pm = strategy === "pm" && choice.shift.id === "PM" ? 52 : 0;
          const balance = strategy === "balanced" ? -(state.mix[choice.shift.id] || 0) : 0;
          return pm + target + balance + pattern + (paired && state.cycleShift === choice.shift.id ? 35 : 0) +
            (pref.preferred === choice.shift.id ? 12 : 0) +
            (n === preferred ? 3 : 0) + (strategy === "custom" ? rule.priority * 2 : 0);
        }
        const ordered = [...entry.choices].sort((a, b) => rank(b) - rank(a));
        for (const choice of ordered) {
          const n = shifts.indexOf(choice.shift);
          const regularOff = choice.shift?.kind === "off";
          if (paired && regularOff && assignedOff >= (demand.rule.maxOff ?? Infinity)) {
            track(index, "Daily OFF cap pruned a search branch", { setting: "demand", current: demand.rule.maxOff, available: assignedOff + 1 });
            continue;
          }
          if (n >= 0 && settings[n].max !== null && counts[n] >= settings[n].max) {
            track(index, shifts[n].id + " maximum pruned a search branch", { shift: shifts[n].id,
              setting: "coverage", coverage: [id, date, shifts[n].id], current: settings[n].max, available: counts[n] + 1 });
            continue;
          }
          if (n >= 0) { counts[n]++; working++; }
          if (regularOff) assignedOff++;
          next[entry.n] = choice.next;
          if (!entry.outside) cells[entry.k] = choice.shift.id;
          if (assign(i + 1)) return true;
          if (n >= 0) { counts[n]--; working--; }
          if (regularOff) assignedOff--;
          if (stopped) return false;
        }
        return false;
      }
      return assign(0);
    }
    if (!solveDay(0, states)) {
      return { status: stopped ? "timeout" : "infeasible", reason: (reason || id + ": no candidate found within the search budget") +
        ". Review locks, rest rules, eligible shifts and coverage.", steps, best,
        observations: [...observations.values()].sort((a, b) => b.index - a.index).slice(0, 8).map(item => item.issue) };
    }
    completed += context.dates.length * selectedCount;
  }
  const selectedIds = new Set(context.people.filter(person => groups.includes(person.group) && selected.has(person.id)).map(person => person.id));
  const checked = validate(context, cells, { people: selectedIds, groups });
  if (checked.errors.length) return { status: "infeasible", reason: checked.errors[0].label, steps };
  return { status: "feasible", cells, steps, warnings: checked.warnings, selectedCount: selectedIds.size, scopeGroups: groups, scopePeople: [...selectedIds],
    totals: totals(context.catalog, Object.values(cells)) };
}

export function generateCandidates(context, options = {}, progress) {
  if (!pairedPolicy(context) || options.strategy === "previous" || options.budget != null || options.timeout != null) {
    return generateSequentialCandidates(context, options, progress);
  }
  const monthly = generateMonthly(context, options, progress);
  if (monthly.status !== "timeout" || options.trial) return monthly;
  // Preserve cases solvable by the old search, without discarding the full monthly alternative.
  progress?.({ profile: "coverage validation fallback" });
  const fallback = generateSequentialCandidates(context, { ...options, retry: false });
  if (fallback.status !== "feasible") return monthly;
  const best = fallback.candidates[0];
  const checked = validate(context, best.cells, { people: new Set(best.scopePeople), groups: best.scopeGroups });
  const metrics = candidateMetrics(context, best.cells, best.scopePeople, best.scopeGroups, checked);
  return { ...monthly, status: "feasible", feasibility: "Confirmed feasible",
    candidates: [{ ...best, metrics, errors: checked.errors, profile: "Validated fallback" }, ...monthly.candidates].slice(0, 3) };
}

function generateSequentialCandidates(context, options, progress) {
  const candidates = [], seen = new Set();
  const strategy = options.strategy || (context.team === "Affiliate" ? "pm" : "balanced");
  const { issues, suggestions } = diagnose(context, options);
  if (issues.some(issue => issue.certainty === "Confirmed")) {
    return { status: "infeasible", reason: "Preflight found confirmed conflicts.", issues, suggestions };
  }
  let firstFailure, best;
  const recovery = Boolean(options.retry);
  const budget = recovery ? 180000 : 60000, timeout = recovery ? 2300 : 1150;
  for (let variant = 0; variant < 3; variant++) {
    progress?.({ variant: variant + 1 });
    const ordering = recovery && variant === 2 && ["balanced", "pm"].includes(strategy) ? (strategy === "pm" ? "balanced" : "pm") : strategy;
    const result = generate(context, { ...options, strategy: ordering, variant: variant + (recovery ? 3 : 0), recover: true,
      timeout: Math.min(options.timeout ?? timeout, timeout), budget: Math.min(options.budget ?? budget, budget),
      progress: update => progress?.({ variant: variant + 1, ...update }) });
    if (result.status !== "feasible") {
      if (!firstFailure || result.status !== "timeout") firstFailure = result;
      if (result.best && result.best.completed > (best?.completed || 0)) best = result.best;
      if (result.status !== "timeout") break;
      continue;
    }
    const signature = JSON.stringify(result.cells);
    if (seen.has(signature)) continue;
    seen.add(signature);
    const report = coverageReport(context, result.cells);
    const target = report.daily.flatMap(day => day.shifts).reduce((sum, s) => sum + Math.min(s.count, s.target) * (1 + s.priority), 0);
    candidates.push({ ...result, report, target, variant });
  }
  if (!candidates.length) {
    if (options.keepAssigned && !suggestions.some(item => item.id === "refill") && context.people.some(p => {
      const { selected, groups } = generationScope(context, options);
      return selected.has(p.id) && groups.includes(p.group) && context.dates.some(date => {
        const k = key(p.id, date);
        return context.draft.cells[k] && !context.leave[k] && !isLocked(context, p.id, date);
      });
    })) suggestions.push({ id: "refill", current: "Fill empty cells only", proposed: "Regenerate unlocked assignments",
      effect: "Search can replace unlocked assignments. Locks and confirmed leave remain unchanged." });
    return { ...firstFailure, best, issues: [...issues, ...(firstFailure.observations || [])], suggestions };
  }
  const scopeMetric = (candidate, metric) => {
    if (metric === "alignment") return candidate.report.daily.filter(day => candidate.scopeGroups.includes(day.group))
      .reduce((sum, day) => sum + day.alignment, 0);
    return candidate.report.staff.filter(person => candidate.scopePeople.includes(person.id)).reduce((sum, person) => sum + person[metric], 0);
  };
  candidates.sort((a, b) => (pairedPolicy(context) ? scopeMetric(a, "alignment") - scopeMetric(b, "alignment") ||
    scopeMetric(a, "cycleTransitions") - scopeMetric(b, "cycleTransitions") : 0) || (strategy === "pm" ? b.report.pm - a.report.pm : 0) ||
    b.target - a.target || b.report.preferenceHits - a.report.preferenceHits ||
    (pairedPolicy(context) && context.draft.rules.fair ? a.report.fairness - b.report.fairness : 0) || a.variant - b.variant);
  return { status: "feasible", candidates, issues };
}

if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
  self.onmessage = ({ data }) => {
    try { self.postMessage(generateCandidates(data.context, data.options, progress => self.postMessage({ progress }))); }
    catch (error) { self.postMessage({ status: "error", reason: error.message }); }
  };
}
