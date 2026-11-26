import { coverage, dateAt, dayIndex, isLocked, key, totals, weekday } from "./roster-model.js";

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
const historySize = context => Math.max(7, context.draft.rules.maxRun, Math.ceil(context.draft.rules.rest / 24) + 2);
function initialState(context, person) {
  const date = context.dates[0], catalog = lookup(context.previousCatalog);
  const state = { run: 0, end: -Infinity, off: 0, unknown: 0, weekendOff: 0, work: 0 };
  for (let i = historySize(context); i > 0; i--) {
    const prior = dateAt(dayIndex(date) - i);
    const shift = catalog.get(context.previous[key(person.id, prior)]);
    state.run = shift?.kind === "work" ? state.run + 1 : 0;
    if (shift?.kind === "work") state.end = interval(prior, shift)[1];
    if (i <= weekOffset(date)) {
      if (shift?.kind === "off") state.off++;
      if (!shift) state.unknown++;
    }
  }
  return state;
}
function advance(state, date, shift, rules) {
  const offset = weekOffset(date);
  const next = { ...state, off: offset ? state.off : 0, unknown: offset ? state.unknown : 0 };
  let problem = "";
  if (shift?.kind === "work") {
    const [start, end] = interval(date, shift);
    if (start - state.end < rules.rest * 60) problem = "Insufficient rest between shifts";
    if (++next.run > rules.maxRun) problem ||= "Too many consecutive workdays";
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
  if (next.off + next.unknown + (6 - offset) < rules.weeklyOff) problem ||= "Weekly OFF minimum cannot be met";
  return { next, problem };
}
const requirement = (context, group, date, shift) =>
  context.draft.coverage[[group, date, shift].join("|")] ?? context.draft.coverage[[group, "*", shift].join("|")] ?? 0;

export function validate(context, cells = context.draft.cells) {
  const errors = [], warnings = [], catalog = lookup(context.catalog), rules = context.draft.rules;
  const put = (target, type, label) => target.push({ type, label });
  for (const person of context.people) {
    if (person.group === "unassigned") put(warnings, "group", person.name + " is unassigned");
    if (context.conflicts?.includes(person.id)) put(errors, "group", person.name + " has conflicting group membership");
    let state = initialState(context, person);
    const start = dayIndex(context.dates[0]);
    if (Array.from({ length: historySize(context) }, (_, i) => dateAt(start - 1 - i))
      .some(date => !context.previousCatalog.some(s => s.id === context.previous[key(person.id, date)]))) {
      put(warnings, "boundary", person.name + ": previous boundary incomplete; unknown dates are not assumed working or OFF");
    }
    for (const date of context.dates) {
      const k = key(person.id, date), value = cells[k], shift = catalog.get(value);
      const label = person.name + " on " + date;
      if (Array.isArray(value)) put(errors, "duplicate", "Duplicate assignments: " + label);
      else if (!value) put(errors, "missing", "Missing assignment: " + label);
      else if (!shift) put(errors, "invalid", "Invalid shift: " + label);
      if (context.leave[k] && value !== context.leave[k]) put(errors, "leave", "Confirmed leave conflict: " + label);
      const fixed = context.draft.preferences[person.id]?.fixed;
      if (fixed && shift?.kind === "work" && fixed !== value) put(errors, "fixed", "Fixed shift conflict: " + label);
      const { next, problem } = advance(state, date, shift, rules);
      if (problem) put(errors, "rule", problem + ": " + label);
      state = next;
    }
    const last = context.dates.at(-1);
    if (weekOffset(last) < 6 && state.off < rules.weeklyOff) {
      put(warnings, "boundary", person.name + ": " + (rules.weeklyOff - state.off) + " OFF day(s) still due in next month's opening week");
    }
  }
  for (const group of [...context.groups.map(g => g.id), "unassigned"]) {
    const groupPeople = context.people.filter(p => p.group === group);
    const counts = coverage(groupPeople, context.dates, cells);
    context.dates.forEach((date, i) => {
      for (const shift of context.catalog.filter(s => s.kind === "work")) {
        const min = requirement(context, group, date, shift.id), have = counts[i][shift.id] || 0;
        if (have < min) put(errors, "coverage", (context.groups.find(g => g.id === group)?.name || "Unassigned") +
          " " + date + " " + shift.id + ": " + have + "/" + min);
      }
    });
  }
  return { errors, warnings };
}

export function generate(context, { group = "", keepAssigned = false, budget = 180000, timeout = 3500 } = {}) {
  const cells = { ...context.draft.cells }, rules = context.draft.rules;
  const shifts = context.catalog.filter(s => s.kind === "work");
  const off = context.catalog.find(s => s.kind === "off"), catalog = lookup(context.catalog);
  const groups = group ? [group] : [...context.groups.map(g => g.id), "unassigned"];
  const deadline = performance.now() + timeout;
  let steps = 0, stopped = false, deepest = -1, reason = "";
  if (!off || context.conflicts?.length) return { status: "infeasible", reason: "Resolve invalid catalog or group membership first." };
  for (const id of groups) {
    const people = context.people.filter(p => p.group === id);
    const required = context.dates.map(date => shifts.map(s => requirement(context, id, date, s.id)));
    const over = required.findIndex(values => values.reduce((a, b) => a + b, 0) > people.length);
    if (over !== -1) return { status: "infeasible", reason: id + ": minimum coverage exceeds available staff on " + context.dates[over] };
    deepest = -1;
    reason = "";
    const track = (index, message) => {
      if (index >= deepest) { deepest = index; reason = (context.groups.find(g => g.id === id)?.name || "Unassigned") +
        " on " + context.dates[index] + ": " + message; }
    };
    function solveDay(index, states) {
      if (index === context.dates.length) return true;
      const date = context.dates[index];
      const options = people.map((person, n) => {
        const k = key(person.id, date), saved = cells[k], fixed = context.draft.preferences[person.id]?.fixed;
        const leave = context.leave[k], locked = isLocked(context, person.id, date);
        const conflict = leave && saved && leave !== saved;
        const choices = conflict ? [] : leave ? [catalog.get(leave)] : locked || (keepAssigned && saved) ? [catalog.get(saved)] :
          [off, ...shifts.filter(s => !fixed || fixed === s.id)];
        return { n, k, choices: choices.filter(s => s && (!fixed || s.kind !== "work" || s.id === fixed)).map(shift => ({
          shift, ...advance(states[n], date, shift, rules)
        })).filter(option => !option.problem) };
      }).sort((a, b) => a.choices.length - b.choices.length ||
        states[b.n].work - states[a.n].work || ((a.n + index) % people.length) - ((b.n + index) % people.length));
      if (options.some(entry => !entry.choices.length)) {
        track(index, "a lock, confirmed leave, fixed shift, rest, consecutive work, or weekly OFF rule leaves no eligible assignment");
        return false;
      }
      const remaining = [...required[index]], next = [];
      function assign(i) {
        if (++steps > budget || (steps % 64 === 0 && performance.now() >= deadline)) { stopped = true; return false; }
        for (const [n, min] of remaining.entries()) {
          if (min > 0 && options.slice(i).filter(entry => entry.choices.some(c => c.shift.id === shifts[n].id)).length < min) {
            track(index, shifts[n].id + " coverage cannot be met with eligible staff");
            return false;
          }
        }
        if (i === options.length) return solveDay(index + 1, next);
        const entry = options[i], state = states[entry.n], offset = weekOffset(date);
        const preferred = (entry.n + (context.draft.preferences[people[entry.n].id]?.rotate ? Math.floor(index / 7) : 0)) % Math.max(1, shifts.length);
        function rank(choice) {
          const n = shifts.indexOf(choice.shift);
          if (n >= 0 && remaining[n] > 0) return 100 + remaining[n];
          if (choice.shift.kind === "off") {
            const due = Math.max(0, rules.weeklyOff - (offset ? state.off : 0));
            if (!due) return -20;
            if (!rules.fair) return 20;
            const phase = (entry.n + 2 * Math.floor((index + weekOffset(context.dates[0])) / 7)) % 7;
            const preferredOff = Array.from({ length: rules.weeklyOff }, (_, i) => (phase + Math.floor(i * 7 / rules.weeklyOff)) % 7);
            return preferredOff.includes(offset) ? 30 - (offset >= 5 ? state.weekendOff : 0) : -10;
          }
          return n === preferred ? 10 : 0;
        }
        const ordered = [...entry.choices].sort((a, b) => rank(b) - rank(a));
        for (const choice of ordered) {
          const n = shifts.indexOf(choice.shift);
          if (n >= 0) remaining[n]--;
          next[entry.n] = choice.next;
          cells[entry.k] = choice.shift.id;
          if (assign(i + 1)) return true;
          if (n >= 0) remaining[n]++;
          if (stopped) return false;
        }
        return false;
      }
      return assign(0);
    }
    if (!solveDay(0, people.map(person => initialState(context, person)))) {
      return { status: stopped ? "timeout" : "infeasible", reason: reason || id + ": no candidate found within the search budget", steps };
    }
  }
  const checked = validate(context, cells);
  const selectedIds = new Set(context.people.filter(person => groups.includes(person.group)).map(person => person.id));
  if (checked.errors.length && !group) return { status: "infeasible", reason: checked.errors[0].label, steps };
  return { status: "feasible", cells, steps, warnings: checked.warnings, selectedCount: selectedIds.size,
    totals: totals(context.catalog, Object.values(cells)) };
}

if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
  self.onmessage = ({ data }) => {
    try { self.postMessage(generate(data.context, data.options)); }
    catch (error) { self.postMessage({ status: "error", reason: error.message }); }
  };
}
