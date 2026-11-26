import { dateAt, dayIndex, isLocked, key, totals, weekday, weekdays, datesFor, previousMonth } from "./roster-model.js";
import { coverageReport, coverageRule, eligible, staffRules, validCoverage } from "./roster-policy.js";

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
function initialState(context, person) {
  const date = context.dates[0], catalog = lookup(context.previousCatalog);
  const state = { run: 0, end: -Infinity, off: 0, unknown: 0, weekendOff: 0, work: 0, lastShift: "",
    streak: 0, best: 0, possible: 0, bestPossible: 0, mix: {} };
  for (let i = historySize(staffRules(context, person.id)); i > 0; i--) {
    const prior = dateAt(dayIndex(date) - i);
    const shift = catalog.get(context.previous[key(person.id, prior)]);
    state.run = shift?.kind === "work" ? state.run + 1 : 0;
    if (shift?.kind === "work") state.end = interval(prior, shift)[1];
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
    if (rules.restrictRotation && state.lastShift && state.lastShift !== shift.id) problems.push("Shift rotation is restricted");
    next.lastShift = shift.id;
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
  if (next.off + next.unknown + (6 - offset) < rules.weeklyOff) problems.push("Weekly OFF minimum cannot be met");
  if (next.bestPossible < rules.consecutiveOff && next.possible + (6 - offset) < rules.consecutiveOff) {
    problems.push("Consecutive OFF requirement cannot be met");
  }
  return { next, problems };
}

export function validate(context, cells = context.draft.cells, scope = {}) {
  const errors = [], warnings = [], catalog = lookup(context.catalog);
  const put = (target, type, label, ref = {}) => target.push({ type, label, ...ref });
  for (const person of context.people) {
    if (scope.people && !scope.people.has(person.id)) continue;
    const rules = staffRules(context, person.id);
    if (person.group === "unassigned") put(warnings, "group", person.name + " is unassigned");
    if (context.conflicts?.includes(person.id)) put(errors, "group", person.name + " has conflicting group membership");
    let state = initialState(context, person);
    const start = dayIndex(context.dates[0]);
    if (Array.from({ length: historySize(rules) }, (_, i) => dateAt(start - 1 - i))
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
    if (weekOffset(last) < 6 && state.off < rules.weeklyOff) {
      put(warnings, "boundary", person.name + ": " + (rules.weeklyOff - state.off) + " OFF day(s) still due in next month's opening week");
    }
    if (weekOffset(last) < 6 && state.best < rules.consecutiveOff) {
      put(warnings, "boundary", person.name + ": consecutive OFF requirement carries into the next month.");
    }
  }
  for (const day of coverageReport(context, cells).daily) {
    if (scope.groups && !scope.groups.includes(day.group)) continue;
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
    const preferences = people.map(person => staffRules(context, person.id));
    for (const [index, date] of context.dates.entries()) {
      const name = context.groups.find(g => g.id === id)?.name || "Unassigned";
      const limits = config[index];
      if (limits.some(rule => !validCoverage(rule))) return { status: "infeasible", code: "coverage",
        reason: name + " has an invalid minimum, target, maximum or priority on " + date };
      const available = people.filter(person => !context.leave[key(person.id, date)]).length;
      if (limits.reduce((n, rule) => n + rule.min, 0) > available) return { status: "infeasible", code: "staffing",
        reason: name + ": minimum coverage exceeds available staff on " + date + ". Review minimums, eligibility or a manual transfer." };
      for (const person of people) {
        const k = key(person.id, date), value = cells[k];
        if (context.leave[k] && value && context.leave[k] !== value) return { status: "infeasible", code: "leave",
          reason: "Confirmed leave conflicts with " + person.name + "'s assignment on " + date };
        if (!context.leave[k] && selected.has(person.id) && isLocked(context, person.id, date) && !catalog.has(value)) {
          return { status: "infeasible", code: "locked", reason: person.name + " has a blank or invalid locked assignment on " + date };
        }
      }
    }
    deepest = -1;
    reason = "";
    const track = (index, message) => {
      if (index >= deepest) { deepest = index; reason = (context.groups.find(g => g.id === id)?.name || "Unassigned") +
        " on " + context.dates[index] + ": " + message; }
    };
    function solveDay(index, states) {
      if (index === context.dates.length) return true;
      const date = context.dates[index], settings = config[index];
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
        if (i === options.length) return solveDay(index + 1, next);
        const entry = options[i], state = states[entry.n], offset = weekOffset(date), pref = preferences[entry.n];
        const preferred = (entry.n + variant + (pref.rotate ? Math.floor(index / 7) : 0)) % Math.max(1, shifts.length);
        const prior = priorDates[index] && context.previous[key(people[entry.n].id, priorDates[index])];
        function rank(choice) {
          if (!choice.shift) return 0;
          const n = shifts.indexOf(choice.shift);
          if (n >= 0 && counts[n] < settings[n].min) return 1000 + settings[n].priority;
          const pattern = strategy === "previous" && choice.shift.id === prior ? 30 : 0;
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
          return pm + target + balance + pattern + (pref.preferred === choice.shift.id ? 12 : 0) +
            (n === preferred ? 3 : 0) + (strategy === "custom" ? rule.priority * 2 : 0);
        }
        const ordered = [...entry.choices].sort((a, b) => rank(b) - rank(a));
        for (const choice of ordered) {
          const n = shifts.indexOf(choice.shift);
          if (n >= 0 && settings[n].max !== null && counts[n] >= settings[n].max) {
            track(index, shifts[n].id + " maximum conflicts with eligible or fixed assignments");
            continue;
          }
          if (n >= 0) counts[n]++;
          next[entry.n] = choice.next;
          if (!entry.outside) cells[entry.k] = choice.shift.id;
          if (assign(i + 1)) return true;
          if (n >= 0) counts[n]--;
          if (stopped) return false;
        }
        return false;
      }
      return assign(0);
    }
    if (!solveDay(0, people.map(person => initialState(context, person)))) {
      return { status: stopped ? "timeout" : "infeasible", reason: (reason || id + ": no candidate found within the search budget") +
        ". Review locks, rest rules, eligible shifts and coverage.", steps };
    }
  }
  const selectedIds = new Set(context.people.filter(person => groups.includes(person.group) && selected.has(person.id)).map(person => person.id));
  const checked = validate(context, cells, { people: selectedIds, groups });
  if (checked.errors.length) return { status: "infeasible", reason: checked.errors[0].label, steps };
  return { status: "feasible", cells, steps, warnings: checked.warnings, selectedCount: selectedIds.size,
    totals: totals(context.catalog, Object.values(cells)) };
}

export function generateCandidates(context, options = {}, progress) {
  const candidates = [], seen = new Set();
  const strategy = options.strategy || (context.team === "Affiliate" ? "pm" : "balanced");
  let firstFailure;
  for (let variant = 0; variant < 3; variant++) {
    progress?.({ variant: variant + 1 });
    const result = generate(context, { ...options, strategy, variant, timeout: 1150, budget: 60000,
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
  candidates.sort((a, b) => (strategy === "pm" ? b.report.pm - a.report.pm : 0) ||
    b.target - a.target || b.report.preferenceHits - a.report.preferenceHits || a.variant - b.variant);
  return { status: "feasible", candidates };
}

if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
  self.onmessage = ({ data }) => {
    try { self.postMessage(generateCandidates(data.context, data.options, progress => self.postMessage({ progress }))); }
    catch (error) { self.postMessage({ status: "error", reason: error.message }); }
  };
}
