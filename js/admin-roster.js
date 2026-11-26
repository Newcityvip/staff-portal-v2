import { contextFor, coverage, createHistory, datesFor, draftFor, isLocked, key, previousPattern,
  restore, save, snapshot, totals, transfer, weekday, weekdays } from "./roster-model.js";
import { validate } from "./roster-generator.js";
import { downloadRoster } from "./roster-export.js";

const $ = id => document.getElementById(id);
const initial = restore(localStorage);
const history = createHistory(initial.model);
let team = initial.team, month = initial.month, group = "", preview = false;
let saved = JSON.stringify(initial), current, clipboard = [], selected = new Set(), anchor = "", worker;
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

function renderGrid() {
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
  function addCoverage(body, people, prefix) {
    const counts = coverage(people, current.dates, current.draft.cells);
    for (const shift of workShifts()) {
      const tr = body.insertRow();
      tr.className = "coverage";
      tr.append(make("th", prefix + shift.id, { scope: "row", class: "name" }));
      counts.forEach(day => { tr.insertCell().textContent = day[shift.id] || 0; });
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
    if (people.length) addCoverage(body, people, "Coverage / ");
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
  $("generate").disabled = preview || Boolean(worker);
  $("group").disabled = preview;
  $("rules").disabled = preview;
  $("groups").disabled = preview;
  $("undo").disabled = preview || !history.canUndo;
  $("redo").disabled = preview || !history.canRedo;
  $("legend").replaceChildren(...current.catalog.map(shift => {
    const item = make("span");
    item.style.setProperty("--shift", shift.color);
    item.append(make("b", shift.id), document.createTextNode(" " + timeLabel(shift)));
    return item;
  }));
  renderGrid();
  updateSelection();
  const issues = validate(current);
  $("validation-title").textContent = "Validation / " + issues.errors.length + " blocking / " + issues.warnings.length + " warnings";
  $("issues").replaceChildren(...[["Blocking issues", issues.errors, "error"], ["Warnings", issues.warnings, "warning"]].map(([text, list, cls]) => {
    const block = make("section"), items = make("ul", "", { class: cls });
    items.append(...list.map(item => make("li", item.label)));
    block.append(make("b", text), list.length ? items : make("p", "None"));
    return block;
  }));
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
  const person = choose(current.people.map(p => [p.id, p.name + " / " + p.id]), current.people[0]?.id);
  const target = choose(groupPairs(current), current.people[0]?.group);
  person.onchange = () => { target.value = current.people.find(p => p.id === person.value)?.group; };
  const effective = input("month", month, { min: "2020-01", max: "2099-12" });
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
    make("h3", "Effective-month assignment"),
    row(label("Staff", person), label("To group", target), label("Effective month", effective), button("Transfer", () => {
      if (!datesFor(effective.value).length || effective.value < "2020-01" || effective.value > "2099-12") {
        feedback.textContent = "Enter a month between 2020 and 2099."; return;
      }
      history.change(model => transfer(model, person.value, target.value, effective.value));
      render();
      feedback.textContent = "Assignment saved. Earlier months and snapshots are unchanged.";
    })),
    feedback
  ]);
}

function rulesDialog() {
  const rules = current.draft.rules;
  const numeric = (value, min, max) => input("number", value, { min, max, step: 1 });
  const off = numeric(rules.weeklyOff, 0, 7), run = numeric(rules.maxRun, 1, 14), rest = numeric(rules.rest, 0, 48), fair = input("checkbox", "");
  fair.checked = rules.fair;
  const scope = choose(groupPairs(current), group || current.groups[0]?.id);
  const day = choose([["*", "All dates (default)"], ...current.dates.map(d => [d, d])], "*");
  const shift = choose(workShifts().map(s => [s.id, s.id]), workShifts()[0]?.id);
  const minimum = numeric(0, 0, current.people.length);
  const coverageKey = () => [scope.value, day.value, shift.value].join("|");
  const showMin = () => { minimum.value = current.draft.coverage[coverageKey()] ?? ""; };
  for (const control of [scope, day, shift]) control.onchange = showMin;
  showMin();
  const person = choose(current.people.map(p => [p.id, p.name]), current.people[0]?.id);
  const pref = choose([["", "Any shift"], ["rotate", "Rotate weekly"], ...workShifts().map(s => [s.id, "Fixed " + s.id])], "");
  const showPref = () => {
    const saved = current.draft.preferences[person.value];
    pref.value = saved?.fixed || (saved?.rotate ? "rotate" : "");
  };
  person.onchange = showPref;
  showPref();
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
    make("h3", "Minimum coverage"),
    row(label("Group", scope), label("Date", day), label("Shift", shift), label("Minimum", minimum), button("Save minimum", () => {
      if (minimum.value !== "" && !range(minimum.value, 0, current.people.length)) { feedback.textContent = "Enter a valid coverage minimum."; return; }
      editDraft(d => { if (minimum.value === "") delete d.coverage[coverageKey()]; else d.coverage[coverageKey()] = +minimum.value; });
      feedback.textContent = "Coverage saved.";
    })),
    make("h3", "Staff preference"),
    row(label("Staff", person), label("Pattern", pref), button("Save preference", () => {
      editDraft(d => { d.preferences[person.value] = { fixed: pref.value === "rotate" ? "" : pref.value, rotate: pref.value === "rotate" }; });
      feedback.textContent = "Preference saved.";
    })),
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
  const acknowledgement = input("checkbox", "");
  const accept = button("Save simulated snapshot", () => {
    if (!acknowledgement.checked || issues.errors.length) return;
    const record = snapshot(current);
    history.change(model => { model.snapshots.push(record); });
    $("dialog").close();
    render();
    notify("Simulated snapshot created. Save draft to keep it in this browser.");
  }, { disabled: "" });
  acknowledgement.onchange = () => { accept.disabled = !acknowledgement.checked || Boolean(issues.errors.length); };
  openDialog("Simulated final confirmation", [
    make("p", "Production publishing is unavailable in prototype mode."),
    make("p", "Before uploading this schedule, please make sure you have checked the Future_Leave_Requests tab for any confirmed leave requests within the selected roster month."),
    row(label("I acknowledge the reminder", acknowledgement)),
    make("p", issues.errors.length ? issues.errors.length + " blocking issues must be resolved first." : "This saves a synthetic snapshot only."),
    accept
  ]);
}

function run() {
  const mode = $("generation").value;
  if (mode === "previous") {
    if (!Object.keys(current.previous).length) return notify("No previous-month draft or snapshot.");
    const cells = previousPattern(current);
    editDraft(d => { d.cells = cells; });
    return notify("Previous pattern copied. Review validation before continuing.");
  }
  if (mode === "group" && !group) return notify("Select a group first.");
  const before = history.current, beforeTeam = team, beforeMonth = month;
  worker = new Worker(new URL("./roster-generator.js", import.meta.url), { type: "module" });
  $("generate").disabled = true;
  notify("Generating draft...");
  const done = result => {
    worker.terminate();
    worker = null;
    if (history.current !== before || team !== beforeTeam || month !== beforeMonth || preview) {
      render(); notify("Roster changed during generation. Run it again to apply the result."); return;
    }
    if (result.status === "feasible") {
      editDraft(d => { d.cells = result.cells; });
      notify("Generated " + result.selectedCount + " staff assignments; review " + result.warnings.length + " warnings.");
    } else {
      render();
      notify(({ timeout: "Search limit reached (feasibility unknown): ", infeasible: "No feasible draft: ", error: "Generator failed: " })[result.status] + result.reason);
    }
  };
  worker.onmessage = event => done(event.data);
  worker.onerror = () => done({ status: "error", reason: "Worker unavailable." });
  worker.postMessage({ context: current, options: { group: mode === "group" || mode === "unlocked" ? group : "" } });
}

$("team").onchange = () => { team = $("team").value; group = ""; selected.clear(); anchor = ""; preview = false; render(); };
$("month").onchange = () => {
  const value = $("month").value;
  if (!$("month").checkValidity() || !datesFor(value).length) { $("month").value = month; return; }
  month = value; selected.clear(); anchor = ""; preview = false; render();
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
$("generate").onclick = run;
$("source").onchange = updateExportGroups;
for (const format of ["csv", "xlsx"]) $(format).onclick = async () => {
  try { $(format).disabled = true; await downloadRoster(exportRecord(), format, $("export-group").value); }
  catch (error) { notify("Export failed: " + error.message); }
  finally { $(format).disabled = false; }
};
window.addEventListener("beforeunload", event => { if (dirty()) { event.preventDefault(); event.returnValue = ""; } });
render();
