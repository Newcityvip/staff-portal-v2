import { contextFor, coverage, createHistory, datesFor, draftFor, isLocked, key, previousPattern,
  restore, save, snapshot, totals, transferMany, weekday, weekdays } from "./roster-model.js";
import { validate } from "./roster-generator.js";
import { downloadRoster } from "./roster-export.js";
import { asCoverage, coverageKey, coverageReport, priorities, validCoverage } from "./roster-policy.js";

const $ = id => document.getElementById(id);
const initial = restore(localStorage);
const history = createHistory(initial.model);
let team = initial.team, month = initial.month, group = "", preview = false;
let saved = JSON.stringify(initial), current, clipboard = [], selected = new Set(), anchor = "", worker;
let showReport = false;
const dirty = () => JSON.stringify({ model: history.current, team, month }) !== saved;
const notify = text => { $("notice").textContent = text; };
const make = (tag, text = "", attrs = {}) => {
  const node = document.createElement(tag);
  node.textContent = text;
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
};
const button = (label, action, attrs) => {
  const result = make("button", label, { type: "button", ...attrs });
  result.addEventListener("click", action);
  return result;
};
const choose = (pairs, value) => {
  const result = make("select");
  for (const [id, name] of pairs) result.add(new Option(name, id));
  result.value = value;
  return result;
};
const input = (type, value, attrs) => make("input", "", { type, value, ...attrs });
const row = (...children) => {
  const result = make("div", "", { class: "form-row" });
  result.append(...children);
  return result;
};
const label = (name, control) => {
  const result = make("label", name);
  result.append(control);
  return result;
};
const fill = (id, pairs, value) => {
  const select = $(id);
  select.replaceChildren(...pairs.map(([key, label]) => new Option(label, key)));
  select.value = pairs.some(([id]) => id === value) ? value : pairs[0]?.[0] || "";
};
const groupPairs = context => [...context.groups.map(g => [g.id, g.name]), ["unassigned", "Unassigned"]];
const exportRecord = () => $("source").value === "draft" ? snapshot(current) : history.current.snapshots[Number($("source").value)];
const updateExportGroups = () => {
  const source = $("source").value;
  const record = source === "draft" ? current : history.current.snapshots[Number(source)];
  fill("export-group", [["", "Combined export"], ...groupPairs(record)], $("export-group").value);
};
const workShifts = () => current.catalog.filter(s => s.kind === "work");
const timeLabel = shift => shift.kind === "work" ? shift.start + " - " + shift.end + (shift.end <= shift.start ? " (+1)" : "") : shift.kind === "off" ? "Day off" : "Leave";
const range = (value, low, high) => Number.isInteger(Number(value)) && value !== "" && +value >= low && +value <= high;

function editDraft(edit) {
  history.change(model => {
    const draft = draftFor(model, team, month);
    const before = JSON.stringify(draft);
    edit(draft);
    if (before !== JSON.stringify(draft)) draft.revision++;
  });
  render();
}
function updateSelection() {
  for (const cell of $("matrix").querySelectorAll(".cell")) cell.setAttribute("aria-pressed", selected.has(cell.dataset.key));
  $("selection").textContent = selected.size ? selected.size + " selected" : "No selection";
  for (const id of ["apply", "copy", "clear", "lock"]) $(id).disabled = preview || !selected.size;
  $("paste").disabled = preview || !selected.size || !clipboard.length;
}
function selectCell(k, event) {
  if (event.shiftKey && anchor) {
    const [startId, startDate] = anchor.split("|"), [endId, endDate] = k.split("|");
    const people = [...$("matrix").querySelectorAll("[data-person]")].map(element => element.dataset.person);
    const [lo, hi] = [people.indexOf(startId), people.indexOf(endId)].sort((a, b) => a - b);
    if (lo >= 0) {
      selected = new Set();
      for (const id of people.slice(lo, hi + 1)) for (const date of current.dates) {
        if ((date >= startDate && date <= endDate) || (date >= endDate && date <= startDate)) selected.add(key(id, date));
      }
    }
  } else if ($("multi").checked || event.ctrlKey || event.metaKey) {
    if (selected.has(k)) selected.delete(k); else selected.add(k);
    anchor = k;
  } else {
    selected = new Set([k]);
    anchor = k;
  }
  updateSelection();
}

function renderGrid(report) {
  const table = $("matrix");
  const scroll = $("scroll"), top = scroll.scrollTop, left = scroll.scrollLeft;
  table.replaceChildren();
  const head = table.createTHead().insertRow();
  head.append(make("th", "Staff member", { class: "name", scope: "col" }));
  for (const date of current.dates) {
    const day = weekday(date);
    const cell = make("th", date.slice(-2), { scope: "col", class: day === 0 || day === 6 ? "weekend" : "" });
    cell.append(make("small", weekdays[day]));
    head.append(cell);
  }
  head.append(make("th", "Work / OFF / Leave", { scope: "col", class: "totals" }));
  function addCoverage(body, people, prefix, groupId = "") {
    const counts = coverage(people, current.dates, current.draft.cells);
    for (const shift of workShifts()) {
      const tr = body.insertRow();
      tr.className = "coverage";
      tr.append(make("th", prefix + shift.id, { scope: "row", class: "name" }));
      counts.forEach((day, index) => {
        const td = tr.insertCell();
        const actual = day[shift.id] || 0;
        td.textContent = actual;
        const date = current.dates[index];
        const stats = report.daily.filter(row => row.date === date && (groupId ? row.group === groupId : true));
        const rules = stats.flatMap(row => row.shifts.filter(s => s.id === shift.id));
        const min = rules.reduce((n, s) => n + s.min, 0), target = rules.reduce((n, s) => n + s.target, 0);
        const max = groupId ? rules[0]?.max : null;
        td.dataset.shortfall = actual < min || max != null && actual > max;
        if (groupId) td.dataset.coverage = [groupId, date, shift.id].join("|");
        td.title = date + " / " + shift.id + ": " + actual + " assigned, " + min + " minimum, " + target + " target, " +
          stats.reduce((n, s) => n + s.available, 0) + " available" + (max == null ? "" : ", " + max + " maximum");
      });
      tr.insertCell().textContent = counts.reduce((sum, day) => sum + (day[shift.id] || 0), 0);
    }
  }
  for (const [id, name] of groupPairs(current)) {
    if (!preview && group && group !== id) continue;
    const people = current.people.filter(person => person.group === id);
    const body = table.createTBody(), heading = body.insertRow();
    heading.append(make("th", name + " / " + people.length, { class: "group-label", scope: "rowgroup" }));
    heading.append(make("td", "", { class: "group-band", colspan: current.dates.length + 1 }));
    for (const person of people) {
      const tr = body.insertRow();
      tr.dataset.person = person.id;
      const nameCell = make("th", "", { scope: "row", class: "name" });
      const locked = Boolean(current.draft.staffLocks[person.id]);
      if (!preview) nameCell.append(button(locked ? "Locked" : "Lock", () =>
        editDraft(d => { if (d.staffLocks[person.id]) delete d.staffLocks[person.id]; else d.staffLocks[person.id] = true; }),
      { class: "row-lock", "aria-label": "Toggle staff lock for " + person.name, "aria-pressed": locked }));
      nameCell.append(document.createTextNode(person.name), make("small", person.id));
      tr.append(nameCell);
      for (const date of current.dates) {
        const k = key(person.id, date), value = current.draft.cells[k] || "";
        const shift = current.catalog.find(s => s.id === value);
        const locked = Boolean(isLocked(current, person.id, date));
        const text = value || "-";
        const tip = person.name + ", " + date + ": " + (shift ? shift.id + " / " + timeLabel(shift) : value || "Unassigned") +
          (current.leave[k] ? " (confirmed leave)" : locked ? " (locked)" : "");
        const attrs = { class: "cell", "data-key": k, "data-code": value, "data-locked": locked, title: tip };
        const cell = preview ? make("span", text, attrs) : button(text, event => selectCell(k, event), { ...attrs, "aria-label": tip });
        if (shift) cell.style.setProperty("--shift", shift.color);
        tr.insertCell().append(cell);
      }
      const count = totals(current.catalog, current.dates.map(date => current.draft.cells[key(person.id, date)]));
      const cell = tr.insertCell();
      cell.className = "totals";
      cell.textContent = [count.work, count.off, count.leave].join(" / ");
    }
    if (people.length || report.daily.some(day => day.group === id && day.shifts.some(s => s.min || s.target))) addCoverage(body, people, "Coverage / ", id);
  }
  addCoverage(table.createTBody(), current.people, "Combined / ");
  scroll.scrollTop = top;
  scroll.scrollLeft = left;
}

function render() {
  current = contextFor(history.current, team, month);
  $("team").value = team;
  $("month").value = month;
  const assignment = $("assignment").value;
  fill("group", [["", "All groups"], ...groupPairs(current)], group);
  fill("assignment", current.catalog.map(s => [s.id, s.id + " / " + timeLabel(s)]), assignment);
  fill("source", [["draft", "Current draft"], ...history.current.snapshots.map((s, i) => [String(i), s.team + " " + s.month + " snapshot r" + s.revision])], $("source").value || "draft");
  updateExportGroups();
  $("period").textContent = new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(month + "-01T00:00:00Z"));
  $("summary").textContent = current.people.length + " staff / " + current.dates.length + " days / Draft r" + current.draft.revision;
  $("save").textContent = dirty() ? "Save draft" : "Saved";
  $("preview").textContent = preview ? "Back to editor" : "Preview";
  $("preview").setAttribute("aria-pressed", preview);
  $("confirm").hidden = !preview;
  $("generation").disabled = preview;
  $("scope").disabled = preview;
  $("empty-only").disabled = preview;
  $("generate").disabled = preview || Boolean(worker);
  $("group").disabled = preview;
  $("rules").disabled = preview;
  $("coverage").disabled = preview;
  $("groups").disabled = preview;
  $("undo").disabled = preview || !history.canUndo;
  $("redo").disabled = preview || !history.canRedo;
  $("legend").replaceChildren(...current.catalog.map(shift => {
    const item = make("span");
    item.style.setProperty("--shift", shift.color);
    item.append(make("b", shift.id), document.createTextNode(" " + timeLabel(shift)));
    return item;
  }));
  const issues = validate(current);
  const report = coverageReport(current, current.draft.cells);
  renderGrid(report);
  updateSelection();
  if (showReport) renderReport(report, issues);
  $("preview").disabled = Boolean(!preview && issues.errors.length);
  $("preview").title = $("preview").disabled ? "Resolve blocking validation issues before preview" : "";
  $("validation-title").textContent = "Validation / " + issues.errors.length + " blocking / " + issues.warnings.length + " warnings";
  $("issues").replaceChildren(...[["Blocking issues", issues.errors, "error"], ["Warnings", issues.warnings, "warning"]].map(([text, list, cls]) => {
    const block = make("section"), items = make("ul", "", { class: cls });
    items.append(...list.map(item => {
      const li = make("li");
      if (item.cell || item.coverage) li.append(button(item.label, () => focusIssue(item), { class: "issue-link" }));
      else li.textContent = item.label;
      return li;
    }));
    block.append(make("b", text), list.length ? items : make("p", "None"));
    return block;
  }));
}

function focusIssue(issue) {
  const value = issue.cell || issue.coverage.join("|");
  const selector = "[" + (issue.cell ? "data-key" : "data-coverage") + '="' + CSS.escape(value) + '"]';
  let target = $("matrix").querySelector(selector);
  if (!target && group) {
    group = ""; selected.clear(); render();
    target = $("matrix").querySelector(selector);
  }
  if (target) {
    target.tabIndex = 0;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "nearest", inline: "center" });
  }
}

function bulk(values) {
  const keys = [...selected];
  const editable = keys.filter(k => !isLocked(current, ...k.split("|")));
  if (!editable.length) return notify("No unlocked cells selected.");
  editDraft(draft => keys.forEach((k, index) => {
    if (isLocked(current, ...k.split("|"))) return;
    const value = values[index % values.length];
    if (value) draft.cells[k] = value; else delete draft.cells[k];
  }));
  notify(editable.length + " updated" + (keys.length !== editable.length ? "; locked cells skipped." : "."));
}

function openDialog(title, content) {
  $("dialog-title").textContent = title;
  $("dialog-content").replaceChildren(...content);
  if (!$("dialog").open) $("dialog").showModal();
}
function groupsDialog() {
  const groupList = choose([["", "New group"], ...current.groups.map(g => [g.id, g.name])], "");
  const name = input("text", "", { maxlength: 40 });
  groupList.onchange = () => { name.value = current.groups.find(g => g.id === groupList.value)?.name || ""; };
  const feedback = make("p", "", { role: "status" });
  const target = choose(groupPairs(current), group || current.people[0]?.group);
  const effective = input("month", month, { min: "2020-01", max: "2099-12" });
  const duration = choose([["permanent", "From effective month"], ["temporary", "Only this month"]], "permanent");
  const checklist = make("div", "", { class: "check-grid" });
  for (const person of current.people) checklist.append(label(person.name + " / " +
    (current.groups.find(g => g.id === person.group)?.name || "Unassigned"), input("checkbox", person.id)));
  openDialog("Brand groups", [
    row(label("Group", groupList), label("Name", name), button("Save group", () => {
      const value = name.value.trim();
      if (!value || current.groups.some(g => g.id !== groupList.value && g.name.toLowerCase() === value.toLowerCase())) {
        feedback.textContent = "Enter a nonempty, unique group name."; return;
      }
      history.change(model => {
        const existing = model.groups.find(g => g.id === groupList.value);
        if (existing) existing.name = value;
        else model.groups.push({ id: crypto.randomUUID(), name: value, team });
      });
      render();
      groupsDialog();
      notify("Group saved in the current draft.");
    })),
    make("h3", "Transfer staff"),
    checklist,
    row(label("To group", target), label("Effective month", effective), label("Duration", duration), button("Transfer", () => {
      const ids = [...checklist.querySelectorAll("input:checked")].map(control => control.value);
      if (!ids.length) { feedback.textContent = "Select at least one staff member."; return; }
      if (!datesFor(effective.value).length || effective.value < "2020-01" || effective.value > "2099-12") {
        feedback.textContent = "Enter a month between 2020 and 2099."; return;
      }
      history.change(model => {
        if (transferMany(model, ids, target.value, effective.value, duration.value === "temporary")) draftFor(model, team, month).revision++;
      });
      render();
      groupsDialog();
      notify(ids.length + " staff transferred. Earlier months and snapshots are unchanged.");
    })),
    feedback
  ]);
}

function coverageDialog(initialGroup = group, initialPeriod = "*") {
  const scope = choose(groupPairs(current), initialGroup || current.groups[0]?.id);
  const period = choose([["*", "Daily defaults"], ...weekdays.map(day => [day, day + " override"]),
    ...current.dates.map(date => [date, date + " override"])], initialPeriod);
  const table = make("table"), holder = make("div", "", { class: "dialog-table" });
  holder.append(table);
  const heading = table.createTHead().insertRow();
  ["Shift", "Override", "Auto", "Min", "Target", "Max", "Priority"].forEach(text => heading.append(make("th", text)));
  const feedback = make("p", "", { role: "status" });
  const summary = make("p", "", { class: "muted" });
  const entries = [];
  const sync = () => {
    const min = entries.reduce((n, e) => n + Number(e.min.value || 0), 0);
    const target = entries.reduce((n, e) => n + Number(e.target.value || 0), 0);
    const people = current.people.filter(person => person.group === scope.value);
    const available = /^\d/.test(period.value) ? people.filter(p => !current.leave[key(p.id, period.value)]).length : people.length;
    summary.textContent = "Total minimum " + min + " / target " + target + " / available " + available +
      (/^\d/.test(period.value) ? " (excluding confirmed leave)" : " before date-specific leave");
  };
  const refresh = () => {
    table.tBodies[0]?.remove();
    const body = table.createTBody();
    entries.length = 0;
    const selectedPeriod = period.value, groupId = scope.value;
    for (const shift of workShifts()) {
      const entryKey = coverageKey(groupId, selectedPeriod, shift.id);
      const exact = current.draft.coverage[entryKey];
      const weekdayKey = /^\d/.test(selectedPeriod) ? weekdays[weekday(selectedPeriod)] : "";
      const rule = asCoverage(exact ?? (weekdayKey ? current.draft.coverage[coverageKey(groupId, weekdayKey, shift.id)] : undefined) ??
        current.draft.coverage[coverageKey(groupId, "*", shift.id)]);
      const override = input("checkbox", "", { "aria-label": shift.id + " override" });
      override.checked = selectedPeriod === "*" || exact !== undefined;
      override.disabled = selectedPeriod === "*";
      const enabled = input("checkbox", "", { "aria-label": shift.id + " automatic generation" });
      enabled.checked = rule.enabled;
      const field = (value, name) => input("number", value ?? "", { min: 0, max: 99, step: 1, "aria-label": shift.id + " " + name });
      const min = field(rule.min, "minimum"), target = field(rule.target, "target"), max = field(rule.max, "maximum");
      const priority = choose(priorities.map((name, i) => [String(i), name]), String(rule.priority));
      priority.setAttribute("aria-label", shift.id + " priority");
      for (const control of [enabled, min, target, max, priority]) control.oninput = () => { override.checked = true; sync(); };
      override.onchange = sync;
      const tr = body.insertRow();
      tr.append(make("th", shift.id, { scope: "row" }));
      for (const control of [override, enabled, min, target, max, priority]) tr.insertCell().append(control);
      entries.push({ entryKey, shift, min, target, max, priority, enabled, override });
    }
    sync();
  };
  scope.onchange = period.onchange = refresh;
  refresh();
  openDialog("Coverage matrix", [row(label("Group", scope), label("Rule period", period)), summary, holder,
    row(button("Save coverage", () => {
      const updates = entries.map(e => [e, { min: e.min.value === "" ? NaN : +e.min.value,
        target: e.target.value === "" ? NaN : +e.target.value, max: e.max.value === "" ? null : +e.max.value,
        priority: +e.priority.value, enabled: e.enabled.checked }]);
      const invalid = updates.find(([e, rule]) => e.override.checked && (!validCoverage(rule) || rule.target > 99 || rule.max > 99));
      if (invalid) { feedback.textContent = invalid[0].shift.id + ": require minimum <= target <= maximum; disabled shifts need zero minimum and target."; return; }
      editDraft(d => {
        for (const [e, rule] of updates) {
          if (e.override.checked) d.coverage[e.entryKey] = rule; else delete d.coverage[e.entryKey];
        }
      });
      feedback.textContent = "Coverage saved.";
    })), feedback]);
}

function preferencesDialog() {
  const person = choose(current.people.map(p => [p.id, p.name]), current.people[0]?.id);
  const fields = make("div");
  const feedback = make("p", "", { role: "status" });
  const refresh = () => {
    const pref = current.draft.preferences[person.value] || {};
    const shifts = workShifts().map(s => [s.id, s.id]);
    const fixed = choose([["", "No fixed shift"], ...shifts], pref.fixed || "");
    const preferred = choose([["", "No preference"], ...shifts], pref.preferred || "");
    const rotation = choose([["", "Any eligible shift"], ["rotate", "Rotate weekly"], ["restricted", "One shift for this month"]],
      pref.restrictRotation ? "restricted" : pref.rotate ? "rotate" : "");
    const choices = (pairs, values) => {
      const block = make("div", "", { class: "check-grid" });
      for (const [value, text] of pairs) {
        const checkbox = input("checkbox", value);
        checkbox.checked = values.includes(value);
        block.append(label(text, checkbox));
      }
      return block;
    };
    const selectedValues = block => [...block.querySelectorAll("input:checked")].map(c => c.value);
    const allowed = choices(shifts, pref.allowed || []);
    const offDays = choices(weekdays.map(day => [day, day]), pref.offDays || []);
    const consecutive = input("number", pref.preferredOffRun ?? (pref.preferConsecutiveOff ? 2 : 0), { min: 0, max: 7, step: 1 });
    const fieldsByRule = [["weeklyOff", "Weekly OFF minimum", 0, 7], ["consecutiveOff", "Required OFF streak", 0, 7],
      ["maxRun", "Max work streak", 1, 14], ["rest", "Rest (hours)", 0, 48]].map(([id, name, min, max]) =>
      ({ id, name, min, max, control: input("number", pref[id] ?? "", { min, max, step: 1, placeholder: "Default" }) }));
    const teamGroup = current.groups.find(g => g.id === current.people.find(p => p.id === person.value)?.group)?.name || "Unassigned";
    fields.replaceChildren(make("p", "Monthly group: " + teamGroup), make("h3", "Mandatory"),
      row(label("Fixed shift", fixed), label("Shift rotation", rotation)), make("p", "Allowed shifts (none selected means any eligible shift)"), allowed,
      row(...fieldsByRule.map(item => label(item.name, item.control))), make("h3", "Preferences"),
      row(label("Preferred shift", preferred), label("Preferred OFF streak", consecutive)), make("p", "Preferred OFF weekdays"), offDays,
      row(button("Save preferences", () => {
        const allowedValues = selectedValues(allowed);
        if (!range(consecutive.value, 0, 7) || fieldsByRule.some(item => item.control.value !== "" && !range(item.control.value, item.min, item.max)) ||
          fixed.value && allowedValues.length && !allowedValues.includes(fixed.value)) {
          feedback.textContent = "Check rule ranges and ensure the fixed shift is allowed."; return;
        }
        const numeric = Object.fromEntries(fieldsByRule.filter(item => item.control.value !== "").map(item => [item.id, +item.control.value]));
        editDraft(d => { d.preferences[person.value] = { ...numeric, fixed: fixed.value, preferred: preferred.value,
          allowed: allowedValues, offDays: selectedValues(offDays), preferredOffRun: +consecutive.value,
          rotate: rotation.value === "rotate", restrictRotation: rotation.value === "restricted" }; });
        feedback.textContent = "Preferences saved.";
      }), button("Monthly group assignments", groupsDialog)));
  };
  person.onchange = refresh;
  refresh();
  openDialog("Staff scheduling preferences", [row(label("Staff", person)), fields, feedback]);
}

function rulesDialog() {
  const rules = current.draft.rules;
  const numeric = (value, min, max) => input("number", value, { min, max, step: 1 });
  const off = numeric(rules.weeklyOff, 0, 7), run = numeric(rules.maxRun, 1, 14), rest = numeric(rules.rest, 0, 48), fair = input("checkbox", "");
  fair.checked = rules.fair;
  const catalogEntry = choose([["", "New shift"], ...current.catalog.map(s => [s.id, s.id])], "");
  const id = input("text", "", { maxlength: 8 }), start = input("time", ""), end = input("time", "");
  const kind = choose([["work", "Working"], ["off", "OFF"], ["leave", "Leave"]], "work");
  const color = input("color", "#82d9ee");
  catalogEntry.onchange = () => {
    const entry = current.catalog.find(s => s.id === catalogEntry.value);
    id.value = entry?.id || "";
    id.disabled = Boolean(entry);
    start.value = entry?.start || "";
    end.value = entry?.end || "";
    color.value = entry?.color || "#82d9ee";
    kind.value = entry?.kind || "work";
    kind.disabled = Boolean(entry);
  };
  const feedback = make("p", "", { role: "status" });
  openDialog("Shift rules", [
    row(label("Weekly OFF minimum", off), label("Max work streak", run), label("Rest (hours)", rest), label("Fair distribution", fair),
      button("Save rules", () => {
        if (!range(off.value, 0, 7) || !range(run.value, 1, 14) || !range(rest.value, 0, 48)) { feedback.textContent = "Check rule ranges."; return; }
        editDraft(d => { d.rules = { weeklyOff: +off.value, maxRun: +run.value, rest: +rest.value, fair: fair.checked }; });
        feedback.textContent = "Rules saved.";
      })),
    row(button("Coverage matrix", () => coverageDialog()), button("Staff preferences", preferencesDialog)),
    make("h3", "Team shift catalog"),
    row(label("Edit", catalogEntry), label("Code", id), label("Type", kind), label("Start", start), label("End", end), label("Color", color),
      button("Save shift", () => {
        const code = id.value.trim().toUpperCase(), type = kind.value;
        if (!/^[A-Z][A-Z0-9]{0,7}$/.test(code) || (!catalogEntry.value && current.catalog.some(s => s.id === code)) ||
            (type === "off" && !catalogEntry.value) || (type === "work" && (!start.value || !end.value || start.value === end.value))) {
          feedback.textContent = "Enter a unique code and distinct start/end times for working shifts."; return;
        }
        history.change(model => {
          const catalog = model.catalogs[team];
          const value = { id: code, kind: type, start: type === "work" ? start.value : "", end: type === "work" ? end.value : "", color: color.value };
          const index = catalog.findIndex(s => s.id === code);
          if (index >= 0) catalog[index] = value; else catalog.push(value);
          draftFor(model, team, month).revision++;
        });
        render();
        rulesDialog();
        notify("Shift catalog updated.");
      })),
    feedback
  ]);
}

function confirmDialog() {
  const issues = validate(current);
  const revision = history.current;
  const acknowledgement = input("checkbox", "");
  const accept = button("Save simulated snapshot", () => {
    if (!acknowledgement.checked || issues.errors.length || revision !== history.current) return;
    const record = snapshot(current);
    history.change(model => { model.snapshots.push(record); });
    $("dialog").close();
    render();
    notify("Simulated snapshot created. Save draft to keep it in this browser.");
  }, { disabled: "" });
  acknowledgement.onchange = () => { accept.disabled = !acknowledgement.checked || Boolean(issues.errors.length); };
  openDialog("Simulated final confirmation", [
    make("p", "Production publishing is unavailable in prototype mode."),
    make("p", "Please check the Future_Leave_Requests tab and confirm that all approved leave requests for the selected roster month have been included before proceeding."),
    row(label("I acknowledge the reminder", acknowledgement)),
    make("p", issues.errors.length ? issues.errors.length + " blocking issues must be resolved first." : "This saves a synthetic snapshot only."),
    accept
  ]);
}

function reportTable(headers, values) {
  const table = make("table"), wrapper = make("div", "", { class: "dialog-table report-table" });
  const head = table.createTHead().insertRow();
  headers.forEach(name => head.append(make("th", name, { scope: "col" })));
  const body = table.createTBody();
  for (const valuesRow of values) {
    const tr = body.insertRow();
    for (const value of valuesRow) tr.insertCell().textContent = String(value);
  }
  wrapper.append(table);
  return wrapper;
}
const countPass = day => day.shifts.every(s => s.count >= s.min && (s.max === null || s.count <= s.max));
const targetRatio = day => day.shifts.reduce((sum, s) => sum + Math.min(s.count, s.target), 0) + "/" +
  day.shifts.reduce((sum, s) => sum + s.target, 0);
function renderReport(report, issues) {
  $("results").hidden = false;
  const groupNames = new Map(groupPairs(current));
  const combined = current.dates.map(date => {
    const days = report.daily.filter(d => d.date === date);
    return { date, name: "Combined", available: days.reduce((n, d) => n + d.available, 0),
      shifts: days.flatMap(d => d.shifts) };
  });
  $("result-report").replaceChildren(
    make("p", report.staff.filter(p => p.work || p.off || p.leave).length + " staff / " + report.dates +
      " dates scheduled / " + report.working + " working shifts / " + report.missing + " unassigned"),
    make("p", issues.errors.length + " blocking / " + issues.warnings.length + " warnings / " +
      issues.errors.filter(e => e.type === "leave").length + " leave conflicts / " +
      issues.errors.filter(e => e.type === "lock").length + " lock conflicts"),
    make("p", "PM coverage: " + report.pmPercent.toFixed(1) + "% (" + report.pm + "/" + report.working +
      " working assignments). Preferences matched: " + report.preferenceHits + "/" + report.preferenceTotal + "."),
    make("p", Object.entries(report.distribution).map(([code, n]) => code + " " + n).join(" / ")),
    reportTable(["Staff", "Group", "Work", "OFF", "Leave", "Preferences"], report.staff.map(p =>
      [p.name, groupNames.get(p.group), p.work, p.off, p.leave, p.preferred + "/" + p.opportunities])),
    make("h3", "Daily coverage"),
    reportTable(["Group", "Date", "Available", "Minimum", "Limits", "Target met"], [...combined, ...report.daily].map(day =>
      [day.name, day.date, day.available, day.shifts.reduce((sum, s) => sum + s.min, 0),
        countPass(day) ? "Met" : "Outside limits", targetRatio(day)]))
  );
}
function reviewCandidates(candidates, guard) {
  const pick = choose(candidates.map((_, i) => [String(i), "Candidate " + (i + 1)]), "0");
  const selectedPreview = make("div");
  const compare = reportTable(["Candidate", "Working", "PM", "PM share", "Target (weighted)", "Preferences"], candidates.map((c, i) =>
    [i + 1, c.report.working, c.report.pm, c.report.pmPercent.toFixed(1) + "%", c.target, c.report.preferenceHits]));
  const renderPreview = () => {
    const candidate = candidates[Number(pick.value)];
    selectedPreview.replaceChildren(make("p", candidate.warnings.length + " validation warnings in generation scope."), reportTable(
      ["Staff", ...current.dates.map(date => date.slice(-2))], current.people.map(p =>
        [p.name, ...current.dates.map(date => candidate.cells[key(p.id, date)] || "-")])));
  };
  pick.onchange = renderPreview;
  renderPreview();
  openDialog("Review generated candidates", [compare, row(label("Preview", pick)), selectedPreview,
    row(button("Apply candidate", () => {
      if (!guard()) { $("dialog").close(); notify("Draft changed. Generate candidates again."); return; }
      const result = candidates[Number(pick.value)];
      $("dialog").close();
      showReport = true;
      editDraft(d => { d.cells = result.cells; });
      $("results").open = true;
      notify("Generated " + result.selectedCount + " staff assignments; review " + result.warnings.length + " warnings.");
    }, { class: "primary" }), button("Discard candidates", () => { $("dialog").close(); notify("Draft unchanged."); }))]);
}

function run() {
  const strategy = $("generation").value, scope = $("scope").value;
  if (strategy === "copy") {
    if (!Object.keys(current.previous).length) return notify("No previous-month draft or snapshot.");
    const ids = scope === "staff" ? new Set([...selected].map(k => k.split("|")[0])) : null;
    if (scope === "group" && !group) return notify("Select a group first.");
    if (ids && !ids.size) return notify("Select a cell for each staff member to include.");
    const cells = previousPattern({ ...current, people: current.people.filter(person => (!ids || ids.has(person.id)) &&
      (scope !== "group" || person.group === group)) }, $("empty-only").checked);
    editDraft(d => { d.cells = cells; });
    return notify("Previous pattern copied. Review validation before continuing.");
  }
  if (scope === "group" && !group) return notify("Select a group first.");
  const ids = scope === "staff" ? [...new Set([...selected].map(k => k.split("|")[0]))] : undefined;
  if (ids && !ids.length) return notify("Select a cell for each staff member to include.");
  const before = history.current, beforeTeam = team, beforeMonth = month;
  const unchanged = () => history.current === before && team === beforeTeam && month === beforeMonth && !preview;
  const job = new Worker(new URL("./roster-generator.js", import.meta.url), { type: "module" });
  worker = job;
  $("generate").disabled = true;
  $("cancel-generation").hidden = false;
  notify("Generating candidates...");
  const done = result => {
    if (worker !== job) return;
    job.terminate();
    worker = null;
    $("cancel-generation").hidden = true;
    render();
    if (!unchanged()) return notify("Roster changed during generation. Run it again.");
    if (result.status === "feasible") {
      notify(result.candidates.length + " candidate(s) ready to review. Draft unchanged.");
      reviewCandidates(result.candidates, unchanged);
    } else {
      notify(({ timeout: "Search limit reached (feasibility unknown): ", infeasible: "No feasible draft: ",
        "missing-boundary": "Previous-month data unavailable: ", error: "Generator failed: ", cancelled: "" })[result.status] + result.reason);
    }
  };
  $("cancel-generation").onclick = () => done({ status: "cancelled", reason: "Generation cancelled. Draft unchanged." });
  worker.onmessage = ({ data }) => {
    if (worker !== job) return;
    if (data.progress) notify("Searching candidate " + data.progress.variant + " of 3" + (data.progress.date ? " / " + data.progress.date : ""));
    else done(data);
  };
  worker.onerror = () => done({ status: "error", reason: "Worker unavailable." });
  worker.postMessage({ context: current, options: { strategy, people: ids, group: scope === "group" ? group : "",
    keepAssigned: $("empty-only").checked } });
}

$("team").onchange = () => {
  team = $("team").value; group = ""; selected.clear(); anchor = ""; preview = false; showReport = false;
  $("results").hidden = true; $("generation").value = team === "Affiliate" ? "pm" : "balanced"; render();
};
$("month").onchange = () => {
  const value = $("month").value;
  if (!$("month").checkValidity() || !datesFor(value).length) { $("month").value = month; return; }
  month = value; selected.clear(); anchor = ""; preview = false; showReport = false; $("results").hidden = true; render();
};
$("group").onchange = () => { group = $("group").value; selected.clear(); anchor = ""; render(); };
$("apply").onclick = () => bulk([$("assignment").value]);
$("clear").onclick = () => bulk([""]);
$("copy").onclick = () => { clipboard = [...selected].map(k => current.draft.cells[k] || ""); updateSelection(); notify(clipboard.length + " copied."); };
$("paste").onclick = () => {
  if (clipboard.some(value => value && !current.catalog.some(s => s.id === value))) return notify("Clipboard contains a shift outside this team catalog.");
  bulk(clipboard);
};
$("lock").onclick = () => editDraft(d => {
  const keys = [...selected].filter(k => !current.leave[k] && !d.staffLocks[k.split("|")[0]]);
  const allLocked = keys.every(k => d.locks[k]);
  for (const k of keys) { if (allLocked) delete d.locks[k]; else d.locks[k] = true; }
});
$("undo").onclick = () => { history.undo(); render(); };
$("redo").onclick = () => { history.redo(); render(); };
$("save").onclick = () => {
  try { save(localStorage, history.current, team, month); saved = JSON.stringify({ model: history.current, team, month }); render(); notify("Draft saved in this browser."); }
  catch { notify("Draft could not be saved. Browser storage may be unavailable or full."); }
};
$("preview").onclick = () => { preview = !preview; selected.clear(); anchor = ""; render(); };
$("confirm").onclick = confirmDialog;
$("groups").onclick = groupsDialog;
$("rules").onclick = rulesDialog;
$("coverage").onclick = () => coverageDialog();
$("generate").onclick = run;
$("source").onchange = updateExportGroups;
for (const format of ["csv", "xlsx"]) $(format).onclick = async () => {
  try { $(format).disabled = true; await downloadRoster(exportRecord(), format, $("export-group").value); }
  catch (error) { notify("Export failed: " + error.message); }
  finally { $(format).disabled = false; }
};
window.addEventListener("beforeunload", event => { if (dirty()) { event.preventDefault(); event.returnValue = ""; } });
$("generation").value = team === "Affiliate" ? "pm" : "balanced";
render();
