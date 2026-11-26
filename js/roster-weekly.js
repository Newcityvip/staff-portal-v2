import { dateAt, dayIndex, key, weekday, weekdays } from "./roster-model.js";

export const pairedPolicy = context => context.draft.rules.offPolicy === "paired";
export const pairNames = weekdays.map((day, i) => day + " / " + weekdays[(i + 1) % 7]);
export function phasesFor(date, off) {
  const day = weekday(date);
  const mask = (1 << day) | (1 << ((day + 6) % 7));
  return off ? mask : 127 ^ mask;
}
export const endingPhase = date => 1 << ((weekday(date) + 1) % 7);
export const phaseIndices = mask => pairNames.map((_, i) => i).filter(i => mask & (1 << i));

export function boundary(context, id) {
  const start = dayIndex(context.dates[0]), end = dayIndex(context.dates.at(-1));
  const read = (index, source, catalog) => {
    const date = dateAt(index);
    const code = source[key(id, date)] || context.leave[key(id, date)];
    return { date, shift: catalog.find(item => item.id === code) };
  };
  return {
    previous: Array.from({ length: 7 }, (_, i) => read(start - 7 + i, context.previous, context.previousCatalog)),
    next: Array.from({ length: 7 }, (_, i) => read(end + 1 + i, context.next || {}, context.nextCatalog || context.catalog))
  };
}

export function boundaryPhases(edges) {
  return [...edges.previous, ...edges.next].reduce((mask, { date, shift }) =>
    shift ? mask & phasesFor(date, shift.kind === "off") : mask, 127);
}

export const workloads = ["Very Busy", "Busy", "Normal", "Quiet"];
export const defaultDemand = { workload: "Normal", maxOff: null, preferredOff: null, minWork: 0 };
export const demandKey = (group, period) => group + "|" + period;
export function demandRule(context, group, date) {
  const stored = context.draft.demand || {};
  return { ...defaultDemand, ...(stored[demandKey(group, date)] ?? stored[demandKey(group, weekdays[weekday(date)])]) };
}
export function validDemand({ workload, maxOff, preferredOff, minWork }) {
  const count = n => Number.isInteger(n) && n >= 0;
  return workloads.includes(workload) && count(minWork) && (maxOff === null || count(maxOff)) &&
    (preferredOff === null || count(preferredOff) && (maxOff === null || preferredOff <= maxOff));
}
export function offCapacity(rule, available, shiftMinimum) {
  return Math.min(rule.maxOff ?? available, Math.max(0, available - Math.max(rule.minWork, shiftMinimum)));
}
export function desiredOff(rule, available) {
  if (rule.preferredOff !== null) return rule.preferredOff;
  return Math.round(available * [0.12, 0.21, 2 / 7, 0.43][workloads.indexOf(rule.workload)]);
}
export function alignment(rule, available, off) {
  const weight = [3, 2, 1, 1][workloads.indexOf(rule.workload)] ?? 1;
  const delta = off - desiredOff(rule, available);
  return (delta > 0 ? weight : 1) * delta ** 2;
}
