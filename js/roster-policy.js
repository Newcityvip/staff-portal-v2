import { coverage, key, totals, weekday, weekdays } from "./roster-model.js";

export const priorities = ["Low", "Normal", "High", "Highest"];
export const defaultCoverage = { min: 0, target: 0, max: null, priority: 1, enabled: true };
export const coverageKey = (group, period, shift) => [group, period, shift].join("|");
export function asCoverage(value) {
  return typeof value === "number" ? { ...defaultCoverage, min: value, target: value } : { ...defaultCoverage, ...value };
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
    return context.dates.map((date, i) => ({
      group: group.id, name: group.name, date,
      available: people.filter(p => !context.leave[key(p.id, date)]).length,
      shifts: shifts.map(shift => ({ id: shift.id, count: counts[i][shift.id] || 0,
        ...coverageRule(context, group.id, date, shift.id) }))
    }));
  });
  const distribution = Object.fromEntries(context.catalog.map(s => [s.id, 0]));
  let assigned = 0, preferenceHits = 0, preferenceTotal = 0;
  const staff = context.people.map(person => {
    const rules = staffRules(context, person.id);
    const values = context.dates.map(date => cells[key(person.id, date)]);
    let preferred = 0, opportunities = 0;
    values.forEach((value, i) => {
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
    preferenceHits += preferred;
    preferenceTotal += opportunities;
    return { id: person.id, name: person.name, group: person.group, ...totals(context.catalog, values), preferred, opportunities };
  });
  const working = shifts.reduce((sum, shift) => sum + distribution[shift.id], 0);
  return { daily, distribution, staff, assigned, working, missing: context.people.length * context.dates.length - assigned,
    dates: context.dates.filter(date => context.people.some(p => cells[key(p.id, date)])).length,
    pm: distribution.PM || 0, pmPercent: working ? (distribution.PM || 0) / working * 100 : 0,
    preferenceHits, preferenceTotal };
}
