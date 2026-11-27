import { blankHoldShift, heldBlank, isLocked, key, protectedNonWork, weekday, weekdays } from "./roster-model.js";
import { coverageRule, eligible } from "./roster-policy.js";
import { alignment, boundary, demandRule, phasesFor } from "./roster-weekly.js";

export const objectives = { balanced: "Best Balanced", pm: "PM Priority", demand: "Demand Priority" };
const hard = 1_000_000;
const positive = n => Number.isInteger(n) && n >= 0 ? n : 0;
const cap = n => Number.isInteger(n) && n >= 0 ? n : Infinity;
const gap = (n, min, max) => Math.max(0, positive(min) - n) + Math.max(0, n - cap(max));

// A node keeps only scheduling state that can affect future legality.
const signature = (state, rules) => [state.phases, state.run, state.end, state.cycleShift, state.pairRun,
  state.changed, rules.restrictRotation ? state.monthShift : ""].join("|");

export function staffGraph(context, person, options, constraints, shifts, settings) {
  const rules = constraints.rulesFor(context, person.id);
  const edges = boundary(context, person.id);
  const initial = constraints.initialState(context, person, edges);
  const fixed = context.dates.map(date => {
    const k = key(person.id, date), saved = context.draft.cells[k];
    if (context.leave[k] && saved && saved !== context.leave[k]) return [];
    if (context.leave[k]) return [context.leave[k]];
    if (heldBlank(context, k)) return [blankHoldShift.id];
    if (isLocked(context, person.id, date) || options.keepAssigned && saved) return [saved];
    return null;
  });
  for (const [i, row] of fixed.entries()) if (row?.length) {
    const shift = shifts.find(s => s.id === row[0]);
    if (shift) initial.phases &= phasesFor(context.dates[i], shift.kind === "off");
  }
  let layer = [];
  for (let phase = 0; phase < 7; phase++) if (initial.phases & (1 << phase)) {
    const daysOff = context.dates.filter(date => phasesFor(date, true) & (1 << phase)).length;
    layer.push({ state: { ...initial, phases: 1 << phase }, edges: [],
      startPenalty: rules.fair ? 12 * (daysOff - context.dates.length * 2 / 7) ** 2 : 0 });
  }
  const graph = [layer];
  for (const [day, date] of context.dates.entries()) {
    const nextLayer = [], seen = new Map();
    for (const node of layer) {
      const off = Boolean(node.state.phases & phasesFor(date, true));
      for (const [code, shift] of shifts.entries()) {
        if (fixed[day] ? !fixed[day].includes(shift.id) :
          (off ? shift.kind !== "off" : shift.kind !== "work" || settings[day].byShift[code]?.enabled === false)) continue;
        if (!eligible(rules, shift)) continue;
        const { next, problems } = constraints.advance(node.state, date, shift, rules);
        if (problems.length || day === context.dates.length - 1 && constraints.nextProblems(next, edges, rules).length) continue;
        const sig = signature(next, rules);
        let target = seen.get(sig);
        if (target === undefined) {
          target = nextLayer.length;
          seen.set(sig, target);
          nextLayer.push({ state: next, edges: [] });
        }
        const preference = (rules.preferred && shift.kind === "work" && shift.id !== rules.preferred ? 3 : 0) +
          (shift.kind === "off" && rules.offDays?.length && !rules.offDays.includes(weekdays[weekday(date)]) ? 2 : 0) +
          (shift.kind === "off" && rules.offPair != null && node.state.phases !== 1 << rules.offPair ? 2 : 0) +
          (shift.kind === "work" && node.state.cycleShift && node.state.cycleShift !== shift.id ? 3 : 0);
        node.edges.push({ target, code, preference });
      }
    }
    if (!nextLayer.length) return null;
    layer = nextLayer;
    graph.push(layer);
  }
  return graph;
}

function bestPath(graph, costs) {
  let next = graph.at(-1).map(() => 0);
  const paths = [];
  for (let day = graph.length - 2; day >= 0; day--) {
    paths[day] = [];
    next = graph[day].map((node, index) => {
      let best = Infinity;
      for (const edge of node.edges) {
        const cost = costs[day][edge.code] + edge.preference + next[edge.target];
        if (cost < best) { best = cost; paths[day][index] = edge; }
      }
      return best;
    });
  }
  const totals = next.map((cost, i) => cost + graph[0][i].startPenalty);
  let index = totals.indexOf(Math.min(...totals));
  return paths.map(day => { const edge = day[index]; index = edge.target; return edge.code; });
}

function groupCost(plan, day, shift, profile) {
  const { counts, working, off, settings } = plan, rule = settings[day];
  const code = plan.shifts[shift], n = counts[day][shift];
  if (code.kind === "off") {
    const before = alignment(rule.demand, rule.available, off[day]);
    const after = alignment(rule.demand, rule.available, off[day] + 1);
    return hard * (gap(off[day] + 1, 0, rule.demand.maxOff) - gap(off[day], 0, rule.demand.maxOff)) +
      (Number.isFinite(after - before) ? (after - before) * (profile === "demand" ? 10 : 4) : 0);
  }
  if (code.kind !== "work") return 0;
  const spec = rule.byShift[shift];
  return hard * (gap(n + 1, spec.min, spec.max) - gap(n, spec.min, spec.max) +
    (working[day] < positive(rule.demand.minWork) ? -1 : 0)) +
    (n < positive(spec.target) ? -(profile === "demand" ? 10 : 5) * (1 + positive(spec.priority)) : 0) +
    (profile === "pm" ? code.id === "PM" ? -22 : 0 : 2 * n + 1);
}

function count(plan, path, sign) {
  path.forEach((code, day) => {
    if (code < 0) return;
    plan.counts[day][code] += sign;
    if (plan.shifts[code].kind === "work") plan.working[day] += sign;
    if (plan.shifts[code].kind === "off") plan.off[day] += sign;
  });
}

function hardGaps(plan) {
  return plan.settings.reduce((total, rule, day) => total + gap(plan.working[day], rule.demand.minWork, null) +
    gap(plan.off[day], 0, rule.demand.maxOff) + rule.byShift.reduce((n, shift, code) => n +
      (shift ? gap(plan.counts[day][code], shift.min, shift.max) : 0), 0), 0);
}

function optimizeGroup(context, group, profile, passCount, salt) {
  const { shifts, settings, people, graphs, fixedPaths } = group;
  const plan = { shifts, settings, counts: settings.map(() => shifts.map(() => 0)),
    working: settings.map(() => 0), off: settings.map(() => 0) };
  const paths = [];
  const assign = index => {
    const costs = settings.map((_, day) => shifts.map((__, shift) => groupCost(plan, day, shift, profile)));
    const next = bestPath(graphs[index], costs);
    count(plan, next, 1);
    return next;
  };
  for (const path of fixedPaths) count(plan, path, 1);
  for (let pass = 0; pass < passCount; pass++) {
    let changed = false;
    for (let j = 0; j < people.length; j++) {
      const index = (salt + pass + (pass % 2 ? people.length - 1 - j : j)) % people.length;
      if (!graphs[index]) continue;
      const before = paths[index];
      if (before) count(plan, before, -1);
      const next = assign(index);
      paths[index] = next;
      changed ||= !before || before.some((code, day) => next[day] !== code);
    }
    if (!changed) break;
  }
  // Release two patterns at once so a local minimum need not trap both people in place.
  let gaps = hardGaps(plan), attempts = 0;
  const order = people.map((_, i) => (i + salt) % people.length).filter(i => paths[i]);
  for (const [j, first] of order.entries()) {
    for (const second of order.slice(j + 1)) {
      if (!gaps || attempts++ >= 20) break;
      const a = paths[first], b = paths[second];
      count(plan, a, -1); count(plan, b, -1);
      const nextB = assign(second), nextA = assign(first);
      const nextGaps = hardGaps(plan);
      if (nextGaps < gaps) {
        paths[first] = nextA; paths[second] = nextB; gaps = nextGaps;
      } else {
        count(plan, nextA, -1); count(plan, nextB, -1);
        count(plan, a, 1); count(plan, b, 1);
      }
    }
    if (!gaps || attempts >= 20) break;
  }
  const cells = {};
  for (const [i, person] of people.entries()) paths[i]?.forEach((code, day) => {
    cells[key(person.id, context.dates[day])] = shifts[code].id;
  });
  return cells;
}

export function optimizeMonth(context, options, scope, constraints, profiles, progress) {
  const { selected, groups } = scope;
  const shifts = [...context.catalog, blankHoldShift], groupPlans = [], impossible = [];
  for (const group of groups) {
    const members = context.people.filter(p => p.group === group);
    if (!members.length) continue;
    const people = members.filter(p => selected.has(p.id));
    const settings = context.dates.map(date => ({
      demand: demandRule(context, group, date), byShift: shifts.map(s => s.kind === "work" ? coverageRule(context, group, date, s.id) : null),
      available: members.filter(p => !protectedNonWork(context, key(p.id, date))).length
    }));
    const graphs = people.map(p => {
      const graph = staffGraph(context, p, options, constraints, shifts, settings);
      if (!graph) impossible.push({ person: p, group });
      return graph;
    });
    const fixedPaths = members.filter(p => !selected.has(p.id)).map(p => context.dates.map(date =>
      shifts.findIndex(s => s.id === context.draft.cells[key(p.id, date)])));
    groupPlans.push({ shifts, settings, people, graphs, fixedPaths });
  }
  const passes = options.trial ? 5 : 7;
  const candidates = profiles.map((profile, variant) => {
    progress?.({ variant: variant + 1, profile: objectives[profile] });
    const cells = { ...context.draft.cells };
    // Keep the better of two independently initialized whole-month plans.
    for (const plan of groupPlans) {
      const first = optimizeGroup(context, plan, profile, passes, variant + (options.retry ? 3 : 0));
      const second = options.trial ? first : optimizeGroup(context, plan, profile, passes, variant + 5);
      const cost = assignments => {
        const metrics = { shifts, settings: plan.settings, counts: plan.settings.map(() => shifts.map(() => 0)),
          working: plan.settings.map(() => 0), off: plan.settings.map(() => 0) };
        let sum = 0;
        const add = (path, score) => path.forEach((code, day) => {
          if (code < 0) return;
          if (score) sum += groupCost(metrics, day, code, profile);
          metrics.counts[day][code]++;
          if (shifts[code].kind === "work") metrics.working[day]++;
          if (shifts[code].kind === "off") metrics.off[day]++;
        });
        for (const path of plan.fixedPaths) add(path, false);
        for (const person of plan.people) add(context.dates.map(date =>
          shifts.findIndex(s => s.id === assignments[key(person.id, date)])), true);
        return sum;
      };
      Object.assign(cells, cost(first) <= cost(second) ? first : second);
    }
    return { cells, variant, profile: objectives[profile] };
  });
  return { candidates, impossible };
}
