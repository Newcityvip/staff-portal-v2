import { dateAt, datesFor, dayIndex, key, teams, weekdays } from "./roster-model.js";

const format = "spv2-roster-diagnostic-1";
const datePattern = /^20\d\d-\d\d-\d\d$/;
const codePattern = /^[A-Z][A-Z0-9]{0,7}$/;
const groupPattern = /^[a-zA-Z0-9_-]{1,45}$/;
const chooseFields = (object, fields) => Object.fromEntries(fields.filter(name => Object.hasOwn(object, name))
  .map(name => [name, object[name]]));
const coverageFields = ["min", "target", "max", "priority", "enabled"];
const demandFields = ["minWork", "maxOff", "preferredOff", "workload"];
const ruleFields = ["offPolicy", "weeklyOff", "maxRun", "rest", "fair"];
const prefFields = ["weeklyOff", "maxRun", "rest", "consecutiveOff", "fixed", "allowed", "preferred", "offPair",
  "offDays", "preferConsecutiveOff", "preferredOffRun", "rotate", "restrictRotation"];
const shiftFields = ["id", "kind", "start", "end", "color"];
const adjacentDays = context => new Set(Array.from({ length: context.dates.length + 28 }, (_, i) =>
  dateAt(dayIndex(context.dates[0]) - 14 + i)));

export function createDiagnosticBundle(context, options = {}) {
  const aliases = new Map(context.people.map((person, i) => [person.id, "Staff-" + String(i + 1).padStart(2, "0")]));
  const dates = adjacentDays(context);
  const cells = source => Object.fromEntries(Object.entries(source || {}).flatMap(([k, value]) => {
    const [id, date] = k.split("|");
    return aliases.has(id) && dates.has(date) ? [[key(aliases.get(id), date), value]] : [];
  }));
  const draft = context.draft;
  const filtered = (source, fields) => Object.fromEntries(Object.entries(source || {}).map(([k, value]) => [k,
    value && typeof value === "object" ? chooseFields(value, fields) : value]));
  return JSON.stringify({ format, context: {
    team: context.team, month: context.month,
    people: context.people.map(p => ({ id: aliases.get(p.id), name: aliases.get(p.id), team: p.team, group: p.group })),
    groups: context.groups.map(group => chooseFields(group, ["id", "name", "team"])),
    catalog: context.catalog.map(s => chooseFields(s, shiftFields)),
    previousCatalog: context.previousCatalog.map(s => chooseFields(s, shiftFields)),
    nextCatalog: context.nextCatalog.map(s => chooseFields(s, shiftFields)),
    previous: cells(context.previous), next: cells(context.next), leave: cells(context.leave), transitions: context.transitions,
    conflicts: (context.conflicts || []).map(id => aliases.get(id)).filter(Boolean),
    draft: { cells: cells(draft.cells), locks: cells(draft.locks),
      staffLocks: Object.fromEntries([...aliases].filter(([id]) => draft.staffLocks[id]).map(([, alias]) => [alias, true])),
      coverage: filtered(draft.coverage, coverageFields), demand: filtered(draft.demand, demandFields), rules: chooseFields(draft.rules, ruleFields),
      preferences: Object.fromEntries([...aliases].filter(([id]) => draft.preferences[id]).map(([id, alias]) =>
        [alias, chooseFields(draft.preferences[id], prefFields)]))
    }
  }, options: { strategy: options.strategy, group: options.group || "", keepAssigned: Boolean(options.keepAssigned),
    people: options.people?.map(id => aliases.get(id)).filter(Boolean) } }, null, 2);
}

const plain = value => value && typeof value === "object" && !Array.isArray(value);
const scalar = value => value === null || typeof value === "boolean" || typeof value === "number" && Math.abs(value) <= 1000 ||
  typeof value === "string" && value.length <= 24;
const bounded = (value, max) => value == null || Number.isInteger(value) && value >= 0 && value <= max;
const token = value => typeof value === "string" && /^[A-Z0-9_-]{0,12}$/.test(value);
const time = value => typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value);
const byFields = (value, fields, test = scalar) => plain(value) && Object.entries(value).every(([k, v]) => fields.includes(k) && test(v, k));
const table = (value, test) => plain(value) && Object.entries(value).every(([k, v]) => test(k, v));
const list = (value, max, test) => Array.isArray(value) && value.length <= max && value.every(test);
const unique = (values, field) => new Set(values.map(v => v[field])).size === values.length;
export const diagnosticMaxBytes = 512_000;
export function readDiagnosticBundle(text) {
  const fail = () => { throw new Error("Not a supported anonymized roster diagnostic bundle."); };
  if (typeof text !== "string" || text.length > diagnosticMaxBytes) fail();
  const data = JSON.parse(text);
  const context = data?.context, options = data?.options;
  if (data?.format !== format || !plain(context) || !plain(options) || !teams.includes(context.team) ||
    typeof context.month !== "string" || !/^20\d\d-(0[1-9]|1[0-2])$/.test(context.month)) fail();
  const dates = datesFor(context.month), dateSet = adjacentDays({ dates });
  const groups = context.groups, people = context.people, draft = context.draft;
  if (!list(groups, 14, g => byFields(g, ["id", "name", "team"], v => typeof v === "string" && v.length <= 50) &&
    groupPattern.test(g.id) && !["unassigned", "__proto__", "constructor", "prototype"].includes(g.id) && g.team === context.team) ||
    !unique(groups, "id")) fail();
  const groupSet = new Set([...groups.map(g => g.id), "unassigned"]);
  if (!list(people, 40, p => byFields(p, ["id", "name", "team", "group"]) &&
    /^Staff-\d{2}$/.test(p.id) && p.name === p.id && p.team === context.team && groupSet.has(p.group)) || !unique(people, "id")) fail();
  const peopleSet = new Set(people.map(p => p.id));
  const catalog = value => list(value, 16, s => byFields(s, shiftFields) && codePattern.test(s.id) &&
    ["work", "off", "leave"].includes(s.kind) && (s.kind !== "work" || time(s.start) && time(s.end))) &&
    unique(value, "id") && value.filter(s => s.kind === "off").length === 1;
  const cellKey = (k, currentOnly) => {
    const [id, day, extra] = k.split("|");
    return !extra && k === key(id, day) && peopleSet.has(id) && datePattern.test(day) &&
      (currentOnly ? dates.includes(day) : dateSet.has(day));
  };
  const settingKey = (k, work) => {
    const [group, period, code, extra] = k.split("|");
    return !extra && groupSet.has(group) && (weekdays.includes(period) || dates.includes(period) || work && period === "*") &&
      (work ? codePattern.test(code || "") && k === group + "|" + period + "|" + code : k === group + "|" + period);
  };
  if (![context.catalog, context.previousCatalog, context.nextCatalog].every(catalog) || !plain(draft) ||
    ![context.previous, context.next].every(source => table(source, (k, v) => cellKey(k, false) && token(v))) ||
    !table(context.leave, (k, v) => cellKey(k, false) && context.catalog.some(s => s.kind === "leave" && s.id === v)) ||
    !table(draft.cells, (k, v) => cellKey(k, true) && (token(v) || list(v, 5, token))) ||
    !table(draft.locks, (k, v) => cellKey(k, true) && typeof v === "boolean") ||
    !table(draft.staffLocks, (k, v) => peopleSet.has(k) && typeof v === "boolean") ||
    !table(draft.coverage, (k, v) => settingKey(k, true) && (typeof v === "number" && scalar(v) || byFields(v, coverageFields))) ||
    !table(draft.demand, (k, v) => settingKey(k, false) && byFields(v, demandFields)) ||
    !byFields(draft.rules, ruleFields) || !["paired", "legacy"].includes(draft.rules.offPolicy) ||
    !bounded(draft.rules.maxRun, 31) || !bounded(draft.rules.rest, 120) ||
    !table(draft.preferences, (id, v) => peopleSet.has(id) && byFields(v, prefFields, (v, name) =>
      ["allowed", "offDays"].includes(name) ? list(v, 16, item => typeof item === "string" && item.length <= 8) : scalar(v)) &&
      bounded(v.maxRun, 31) && bounded(v.rest, 120)) ||
    !list(context.transitions, 120, pair => list(pair, 2, token) && pair.length === 2) ||
    !list(context.conflicts, 40, id => peopleSet.has(id)) ||
    !["pm", "balanced", "custom", "previous"].includes(options.strategy) ||
    !(options.group === "" || groupSet.has(options.group)) || typeof options.keepAssigned !== "boolean" ||
    !(options.people === undefined || list(options.people, 40, id => peopleSet.has(id)))) fail();
  return { context: { ...context, dates }, options: chooseFields(options, ["strategy", "group", "people", "keepAssigned"]) };
}
