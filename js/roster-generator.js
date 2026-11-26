import { dateAt, dayIndex, isLocked, key, totals, weekday, weekdays, datesFor, previousMonth } from "./roster-model.js";
import { coverageReport, coverageRule, eligible, staffRules, validCoverage } from "./roster-policy.js";
import { alignment, boundary, boundaryPhases, demandRule, desiredOff, endingPhase, offCapacity,
  pairedPolicy, phaseIndices, phasesFor, validDemand } from "./roster-weekly.js";

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
      const k = key(person.id, date), value = cells[k], shift = catalog.get(value);
      const label = person.name + " on " + date;
      const ref = { cell: k };
      if (Array.isArray(value)) put(errors, "duplicate", "Duplicate assignments: " + label, ref);
      else if (!value) put(errors, "missing", "Missing assignment: " + label, ref);
      else if (!shift) put(errors, "invalid", "Invalid shift: " + label, ref);
      if (context.leave[k] && value !== context.leave[k]) put(errors, "leave", "Confirmed leave conflict: " + label, ref);
      if (isLocked(context, person.id, date) && context.draft.cells[k] !== value && !context.leave[k]) {
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

export function generate(context, { group = "", people: staffIds, keepAssigned = false, budget = 180000, timeout = 3500,
  strategy = context.team === "Affiliate" ? "pm" : "balanced", variant = 0, progress } = {}) {
  const cells = { ...context.draft.cells }, rules = context.draft.rules;
  const shifts = context.catalog.filter(s => s.kind === "work");
  const off = context.catalog.find(s => s.kind === "off"), catalog = lookup(context.catalog);
  const selected = new Set(staffIds || context.people.map(person => person.id));
  const groups = (group ? [group] : [...context.groups.map(g => g.id), "unassigned"])
    .filter(id => !staffIds || context.people.some(person => person.group === id && selected.has(person.id)));
  const priorDates = datesFor(previousMonth(context.month));
  const deadline = performance.now() + timeout;
  let steps = 0, stopped = false, deepest = -1, reason = "";
  if (!off || context.conflicts?.length || !groups.length) return { status: "infeasible", reason: "Resolve invalid catalog, scope, or group membership first." };
  if (strategy === "previous" && !Object.keys(context.previous).length) {
    return { status: "missing-boundary", reason: "No previous-month draft or snapshot is available. Choose another strategy or prepare the previous month." };
  }
  for (const id of groups) {
    const people = context.people.filter(p => p.group === id);
    const config = context.dates.map(date => shifts.map(s => coverageRule(context, id, date, s.id)));
    const paired = pairedPolicy(context);
    const preferences = people.map(person => rulesFor(context, person.id));
    const edges = people.map(person => paired ? boundary(context, person.id) : null);
    const states = people.map((person, i) => initialState(context, person, edges[i]));
    const demands = context.dates.map((date, i) => {
      const rule = demandRule(context, id, date);
      const available = people.filter(person => !context.leave[key(person.id, date)]).length;
      const cap = offCapacity(rule, available, config[i].reduce((sum, entry) => sum + entry.min, 0));
      return { rule, available, cap };
    });
    for (const [index, date] of context.dates.entries()) {
      const name = context.groups.find(g => g.id === id)?.name || "Unassigned";
      const limits = config[index];
      if (limits.some(rule => !validCoverage(rule))) return { status: "infeasible", code: "coverage",
        reason: name + " has an invalid minimum, target, maximum or priority on " + date };
      const available = people.filter(person => !context.leave[key(person.id, date)]).length;
      if (limits.reduce((n, rule) => n + rule.min, 0) > available) return { status: "infeasible", code: "staffing",
        reason: name + ": minimum coverage exceeds available staff on " + date + ". Review minimums, eligibility or a manual transfer." };
      if (paired && (!validDemand(demands[index].rule) || demands[index].rule.minWork > available)) return {
        status: "infeasible", code: "demand", reason: name + ": check daily OFF limits and available working staff on " + date
      };
      for (const person of people) {
        const k = key(person.id, date), value = cells[k];
        if (context.leave[k] && value && context.leave[k] !== value) return { status: "infeasible", code: "leave",
          reason: "Confirmed leave conflicts with " + person.name + "'s assignment on " + date };
        if (!context.leave[k] && selected.has(person.id) && isLocked(context, person.id, date) && !catalog.has(value)) {
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
            const shift = catalog.get(code);
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
    const track = (index, message) => {
      if (index >= deepest) { deepest = index; reason = (context.groups.find(g => g.id === id)?.name || "Unassigned") +
        " on " + context.dates[index] + ": " + message; }
    };
    function solveDay(index, states) {
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
        const choices = outside ? [catalog.get(saved)] : leave ? [catalog.get(leave)] : locked || (keepAssigned && saved) ? [catalog.get(saved)] :
          [off, ...shifts.filter((s, i) => settings[i].enabled && eligible(pref, s))];
        return { n, k, outside, choices: choices.filter(s => outside || s && eligible(pref, s)).map(shift => ({
          shift, ...(outside ? { next: states[n] } : advance(states[n], date, shift, pref))
        })).filter(option => !option.problems?.length) };
      }).sort((a, b) => a.choices.length - b.choices.length ||
        states[b.n].work - states[a.n].work || ((a.n + index) % people.length) - ((b.n + index) % people.length));
      if (options.some(entry => !entry.choices.length)) {
        track(index, "a lock, confirmed leave, fixed shift, rest, consecutive work, or weekly OFF rule leaves no eligible assignment");
        return false;
      }
      const counts = shifts.map(() => 0), next = [];
      let assignedOff = 0, working = 0;
      function assign(i) {
        if (++steps > budget || (steps % 64 === 0 && performance.now() >= deadline)) { stopped = true; return false; }
        if (steps % 4096 === 0) progress?.({ steps, date, group: id });
        for (const [n, rule] of settings.entries()) {
          const needed = rule.min - counts[n];
          if (needed > 0 && options.slice(i).filter(entry => entry.choices.some(c => c.shift?.id === shifts[n].id)).length < needed) {
            track(index, shifts[n].id + " coverage cannot be met with eligible staff");
            return false;
          }
        }
        if (paired && working + options.slice(i).filter(entry => entry.choices.some(c => c.shift?.kind === "work")).length < demand.rule.minWork) {
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
            track(index, "daily OFF cap conflicts with consecutive OFF pairs");
            continue;
          }
          if (n >= 0 && settings[n].max !== null && counts[n] >= settings[n].max) {
            track(index, shifts[n].id + " maximum conflicts with eligible or fixed assignments");
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
        ". Review locks, rest rules, eligible shifts and coverage.", steps };
    }
  }
  const selectedIds = new Set(context.people.filter(person => groups.includes(person.group) && selected.has(person.id)).map(person => person.id));
  const checked = validate(context, cells, { people: selectedIds, groups });
  if (checked.errors.length) return { status: "infeasible", reason: checked.errors[0].label, steps };
  return { status: "feasible", cells, steps, warnings: checked.warnings, selectedCount: selectedIds.size, scopeGroups: groups, scopePeople: [...selectedIds],
    totals: totals(context.catalog, Object.values(cells)) };
}

export function generateCandidates(context, options = {}, progress) {
  const candidates = [], seen = new Set();
  const strategy = options.strategy || (context.team === "Affiliate" ? "pm" : "balanced");
  let firstFailure;
  for (let variant = 0; variant < 3; variant++) {
    progress?.({ variant: variant + 1 });
    const result = generate(context, { ...options, strategy, variant, timeout: Math.min(options.timeout ?? 1150, 1150),
      budget: Math.min(options.budget ?? 60000, 60000),
      progress: update => progress?.({ variant: variant + 1, ...update }) });
    if (result.status !== "feasible") {
      firstFailure ||= result;
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
  if (!candidates.length) return firstFailure;
  const scopeMetric = (candidate, metric) => {
    if (metric === "alignment") return candidate.report.daily.filter(day => candidate.scopeGroups.includes(day.group))
      .reduce((sum, day) => sum + day.alignment, 0);
    return candidate.report.staff.filter(person => candidate.scopePeople.includes(person.id)).reduce((sum, person) => sum + person[metric], 0);
  };
  candidates.sort((a, b) => (pairedPolicy(context) ? scopeMetric(a, "alignment") - scopeMetric(b, "alignment") ||
    scopeMetric(a, "cycleTransitions") - scopeMetric(b, "cycleTransitions") : 0) || (strategy === "pm" ? b.report.pm - a.report.pm : 0) ||
    b.target - a.target || b.report.preferenceHits - a.report.preferenceHits ||
    (pairedPolicy(context) && context.draft.rules.fair ? a.report.fairness - b.report.fairness : 0) || a.variant - b.variant);
  return { status: "feasible", candidates };
}

if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
  self.onmessage = ({ data }) => {
    try { self.postMessage(generateCandidates(data.context, data.options, progress => self.postMessage({ progress }))); }
    catch (error) { self.postMessage({ status: "error", reason: error.message }); }
  };
}
