import { coverage, key, optionalLimit, totals, weekday, weekdays } from "./roster-model.js";
import { alignment, demandRule, offCapacity, phaseIndices, phasesFor } from "./roster-weekly.js";

export const priorities = ["Low", "Normal", "High", "Highest"];
export const defaultCoverage = { min: 0, target: 0, max: null, priority: 1, enabled: true };
export const coverageKey = (group, period, shift) => [group, period, shift].join("|");
export function asCoverage(value) {
  return typeof value === "number" ? { ...defaultCoverage, min: value, target: value } :
    { ...defaultCoverage, ...value, max: optionalLimit(value?.max) };
}
export function validCoverage({ min, target, max, priority, enabled }) {
  return Number.isInteger(min) && min >= 0 && Number.isInteger(target) && target >= min &&
    (max === null || Number.isInteger(max) && max >= target) && Number.isInteger(priority) && priority >= 0 && priority < priorities.length &&
    typeof enabled === "boolean" && (enabled || min === 0 && target === 0);
}
export function coverageRule(context, group, date, shift) {
  const rules = context.draft.coverage;
  return asCoverage(rules[coverageKey(group, date, shift)] ??
    rules[coverageKey(group, weekdays[weekday(date)], shift)] ?? rules[coverageKey(group, "*", shift)]);
}

export function staffRules(context, id) {
  const defaults = context.draft.rules, p = context.draft.preferences[id] || {};
  return { ...p, weeklyOff: p.weeklyOff ?? defaults.weeklyOff, maxRun: p.maxRun ?? defaults.maxRun,
    rest: p.rest ?? defaults.rest, consecutiveOff: p.consecutiveOff || 0, fair: defaults.fair };
}
export const eligible = (pref, shift) => shift.kind !== "work" ||
  (!pref.fixed || pref.fixed === shift.id) && (!pref.allowed?.length || pref.allowed.includes(shift.id));
export function coverageReport(context, cells) {
  const shifts = context.catalog.filter(s => s.kind === "work");
  const groups = [...context.groups, { id: "unassigned", name: "Unassigned" }];
  const daily = groups.flatMap(group => {
    const people = context.people.filter(p => p.group === group.id);
    const counts = coverage(people, context.dates, cells);
    return context.dates.map((date, i) => {
      const demand = demandRule(context, group.id, date);
      const available = people.filter(p => !context.leave[key(p.id, date)]).length;
      const shiftCounts = shifts.map(shift => ({ id: shift.id, count: counts[i][shift.id] || 0,
        ...coverageRule(context, group.id, date, shift.id) }));
      const working = shiftCounts.reduce((sum, shift) => sum + shift.count, 0);
      const off = counts[i].OFF || 0;
      const min = shiftCounts.reduce((sum, shift) => sum + shift.min, 0);
      return { group: group.id, name: group.name, date, demand, available, working, off, counts: counts[i], shifts: shiftCounts,
        cap: offCapacity(demand, available, min),
        shortfall: Math.max(demand.minWork - working, shiftCounts.reduce((sum, s) => sum + Math.max(0, s.min - s.count), 0)),
        alignment: alignment(demand, available, off) };
    });
  });
  const distribution = Object.fromEntries(context.catalog.map(s => [s.id, 0]));
  let assigned = 0, preferenceHits = 0, preferenceTotal = 0;
  const staff = context.people.map(person => {
    const rules = staffRules(context, person.id);
    const values = context.dates.map(date => cells[key(person.id, date)]);
    const kind = new Map(context.catalog.map(s => [s.id, s.kind]));
    let preferred = 0, opportunities = 0;
    let transitions = 0, cycleTransitions = 0, cycleShift = "", offRun = 0;
    let last = "", maxStreak = 0, run = 0, compliant = 0, weeks = 0, excess = 0, weekendOff = 0;
    let phaseMask = 127;
    const mix = {};
    values.forEach((value, i) => {
      const date = context.dates[i], type = kind.get(value);
      if (type) phaseMask &= phasesFor(date, type === "off");
      if (type === "work") {
        if (last && last !== value) transitions++;
        if (cycleShift && cycleShift !== value) cycleTransitions++;
        cycleShift = value;
        last = value;
        maxStreak = Math.max(maxStreak, ++run);
      } else run = 0;
      offRun = type === "off" ? offRun + 1 : 0;
      if (offRun >= 2) cycleShift = "";
      if (type === "off" && [0, 6].includes(weekday(date))) weekendOff++;
      if (type) mix[value] = (mix[value] || 0) + 1;
      if (Object.hasOwn(distribution, value)) {
        distribution[value]++;
        assigned++;
      }
      if (rules.preferred && shifts.some(s => s.id === value)) {
        opportunities++;
        if (rules.preferred === value) preferred++;
      }
      if (rules.offDays?.includes(weekdays[weekday(context.dates[i])])) {
        opportunities++;
        if (context.catalog.some(s => s.id === value && s.kind === "off")) preferred++;
      }
    });
    for (let i = 0; i + 6 < values.length; i += 7) {
      const chunk = values.slice(i, i + 7);
      const off = chunk.filter(value => kind.get(value) === "off").length;
      const fits = chunk.reduce((mask, value, j) => kind.has(value) ? mask & phasesFor(context.dates[i + j], kind.get(value) === "off") : 0, 127);
      weeks++;
      if (fits) compliant++;
      excess += Math.max(0, off - 2);
    }
    if (rules.offPair != null && phaseMask && values.every(value => kind.has(value))) {
      opportunities++;
      if (phaseIndices(phaseMask).includes(rules.offPair)) preferred++;
    }
    preferenceHits += preferred;
    preferenceTotal += opportunities;
    return { id: person.id, name: person.name, group: person.group, ...totals(context.catalog, values), preferred, opportunities,
      mix, transitions, cycleTransitions, maxStreak, compliant, weeks, excess, weekendOff };
  });
  const working = shifts.reduce((sum, shift) => sum + distribution[shift.id], 0);
  return { daily, distribution, staff, assigned, working, missing: context.people.length * context.dates.length - assigned,
    dates: context.dates.filter(date => context.people.some(p => cells[key(p.id, date)])).length,
    pm: distribution.PM || 0, pmPercent: working ? (distribution.PM || 0) / working * 100 : 0,
    preferenceHits, preferenceTotal, offCompliant: staff.reduce((sum, p) => sum + p.compliant, 0),
    offWeeks: staff.reduce((sum, p) => sum + p.weeks, 0), excessOff: staff.reduce((sum, p) => sum + p.excess, 0),
    transitions: staff.reduce((sum, p) => sum + p.transitions, 0),
    cycleTransitions: staff.reduce((sum, p) => sum + p.cycleTransitions, 0),
    alignment: daily.reduce((sum, d) => sum + d.alignment, 0),
    fairness: staff.length ? Math.max(...staff.map(p => p.work)) - Math.min(...staff.map(p => p.work)) : 0 };
}
