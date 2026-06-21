import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// Pool Profile — companion to the Image Pool. A dropdown of named profiles
// (registry under input/grid_pool/profiles.json) plus create/rename/delete/
// duplicate/export/import actions. Selecting a profile propagates its id into
// any connected Image Pool node's pool_id widget and refreshes that grid, so the
// pool's images switch live at edit time. (Modeled on JSON-Manager/project_key.)

const NODE = "PoolProfile";
const POOL_NODE = "GridImagePool";
const R = "/grid_pool/profiles";

// ---- server calls -----------------------------------------------------------

async function listProfiles() {
  const r = await api.fetchApi(`${R}/list`);
  return (await r.json()).profiles || [];
}

async function postJson(path, body) {
  const r = await api.fetchApi(`${R}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}

// ---- widget helpers ---------------------------------------------------------

function hideWidget(w) {
  if (!w) return;
  if (w.origType === undefined) w.origType = w.type;
  w.type = "hidden";
  w.hidden = true;
  w.computeSize = () => [0, -4];
}

function profileWidget(node) {
  return node.widgets?.find((w) => w.name === "profile");
}

function idWidget(node) {
  return node.widgets?.find((w) => w.name === "profile_id");
}

function currentEntry(node) {
  const combo = profileWidget(node);
  return (node._profiles || []).find((p) => p.name === combo?.value);
}

// Replace a STRING widget with a real combo, preserving its serialized value.
function replaceWithCombo(node, name, values, callback) {
  const idx = node.widgets?.findIndex((w) => w.name === name);
  if (idx === undefined || idx === -1) return null;
  const old = node.widgets[idx];
  const saved = old.value || "";
  const vals = values.length ? values.slice() : [""];
  if (saved && !vals.includes(saved)) vals.unshift(saved);
  node.widgets.splice(idx, 1);
  const combo = node.addWidget("combo", name, saved || vals[0], callback, { values: vals });
  // move from the end back to the original slot
  node.widgets.splice(node.widgets.length - 1, 1);
  node.widgets.splice(idx, 0, combo);
  return combo;
}

// ---- propagation ------------------------------------------------------------

// Push the selected profile id into every connected Image Pool node's pool_id
// widget (the grid keys off getPoolId), then refresh that grid.
function propagate(node) {
  const id = idWidget(node)?.value || "default";
  const out = node.outputs?.[0];
  if (!out?.links) return;
  for (const linkId of out.links) {
    const link = node.graph?.links?.[linkId];
    if (!link) continue;
    const target = node.graph?.getNodeById?.(link.target_id);
    if (!target || target.type !== POOL_NODE) continue;
    const pw = target.widgets?.find((w) => w.name === "pool_id");
    if (pw) pw.value = id;
    target._datasetePoolRefresh?.();
    target.setDirtyCanvas?.(true, true);
  }
}

function applySelection(node) {
  const entry = currentEntry(node);
  const idw = idWidget(node);
  if (idw) idw.value = entry?.id || "";
  propagate(node);
  node.setDirtyCanvas?.(true, true);
}

async function refreshList(node, selectName) {
  const profs = await listProfiles();
  node._profiles = profs;
  const names = profs.map((p) => p.name);
  const combo = profileWidget(node);
  if (combo) {
    combo.options = combo.options || {};
    combo.options.values = names.length ? names : [""];
    if (selectName !== undefined) combo.value = selectName;
    else if (!names.includes(combo.value)) combo.value = names[0] || "";
    applySelection(node);
  }
}

// ---- actions ----------------------------------------------------------------

async function actionCreate(node) {
  const name = prompt("New profile name:");
  if (!name) return;
  try {
    const e = await postJson("create", { name });
    await refreshList(node, e.name);
  } catch (err) { alert("Create failed: " + err); }
}

async function actionRename(node) {
  const e = currentEntry(node);
  if (!e) return alert("Select a profile first");
  const name = prompt("Rename profile:", e.name);
  if (!name || name === e.name) return;
  try {
    await postJson("rename", { id: e.id, name });
    await refreshList(node, name);
  } catch (err) { alert("Rename failed: " + err); }
}

async function actionDuplicate(node) {
  const e = currentEntry(node);
  if (!e) return alert("Select a profile first");
  const name = prompt("Duplicate as:", e.name + " copy");
  if (!name) return;
  try {
    const ne = await postJson("duplicate", { id: e.id, name });
    await refreshList(node, ne.name);
  } catch (err) { alert("Duplicate failed: " + err); }
}

async function actionDelete(node) {
  const e = currentEntry(node);
  if (!e) return alert("Select a profile first");
  if (!confirm(`Delete profile "${e.name}"? This removes its images.`)) return;
  try {
    await postJson("delete", { id: e.id });
    await refreshList(node);
  } catch (err) { alert("Delete failed: " + err); }
}

function actionExport(node) {
  const e = currentEntry(node);
  if (!e) return alert("Select a profile first");
  window.open(`${R}/export?id=${encodeURIComponent(e.id)}`);
}

function actionImport(node) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".zip";
  input.onchange = async () => {
    if (!input.files?.length) return;
    const fd = new FormData();
    fd.append("file", input.files[0], input.files[0].name);
    try {
      const r = await api.fetchApi(`${R}/import`, { method: "POST", body: fd });
      if (!r.ok) throw new Error(await r.text());
      const e = await r.json();
      await refreshList(node, e.name);
    } catch (err) { alert("Import failed: " + err); }
  };
  input.click();
}

// ---- node setup -------------------------------------------------------------

function setupProfileNode(node) {
  hideWidget(idWidget(node));
  replaceWithCombo(node, "profile", [], () => applySelection(node));

  node.addWidget("button", "➕ Create", null, () => actionCreate(node));
  node.addWidget("button", "✎ Rename", null, () => actionRename(node));
  node.addWidget("button", "⧉ Duplicate", null, () => actionDuplicate(node));
  node.addWidget("button", "🗑 Delete", null, () => actionDelete(node));
  node.addWidget("button", "⬇ Export", null, () => actionExport(node));
  node.addWidget("button", "⬆ Import", null, () => actionImport(node));

  node.setSize(node.computeSize());
  refreshList(node);   // async: populate the dropdown
}

app.registerExtension({
  name: "datasete.gates.poolprofile",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      setupProfileNode(this);
      return r;
    };

    // loaded workflows restore the combo + profile_id after create — re-list and
    // re-propagate the saved id once the graph is ready.
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      const node = this;
      queueMicrotask(() => {
        propagate(node);   // propagate saved id immediately
        refreshList(node, profileWidget(node)?.value);
      });
      return r;
    };

    // when our output gets connected to a pool, propagate right away
    const onConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function () {
      const r = onConnectionsChange?.apply(this, arguments);
      propagate(this);
      return r;
    };
  },
});
