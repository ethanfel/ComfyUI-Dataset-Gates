import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// Pool Profile — companion to the Image Pool. A dropdown of named profiles
// (registry under input/grid_pool/profiles.json) plus create/rename/delete/
// duplicate/export/import actions. The pool is switched ONLY when the user
// actively picks a profile in the dropdown (or creates/duplicates/imports one) —
// connecting the node never changes the pool. Selecting an *empty* profile while
// a pool with images is connected offers to seed it from those images, so the
// current pool is never silently lost. (Modeled on JSON-Manager/project_key.)

const NODE = "PoolProfile";
const POOL_NODE = "GridImagePool";
const R = "/grid_pool/profiles";

// ---- server calls -----------------------------------------------------------

async function listProfiles() {
  const r = await api.fetchApi(`${R}/list`);
  return (await r.json()).profiles || [];
}

async function listPoolSlots(poolId) {
  try {
    const r = await api.fetchApi(`/grid_pool/list?pool_id=${encodeURIComponent(poolId)}`);
    return (await r.json()).slots || [];
  } catch (e) { return []; }
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
  node.widgets.splice(node.widgets.length - 1, 1);
  node.widgets.splice(idx, 0, combo);
  return combo;
}

// ---- connected pools + switching --------------------------------------------

function connectedPools(node) {
  const res = [];
  const out = node.outputs?.[0];
  if (!out?.links) return res;
  for (const linkId of out.links) {
    const link = node.graph?.links?.[linkId];
    if (!link) continue;
    const t = node.graph?.getNodeById?.(link.target_id);
    if (t && t.type === POOL_NODE) res.push(t);
  }
  return res;
}

function setIdFromCombo(node) {
  const entry = currentEntry(node);
  const idw = idWidget(node);
  if (idw) idw.value = entry?.id || "";
}

// Push the current profile id into every connected pool's pool_id widget (the
// grid keys off getPoolId) and repaint. Only ever called from user actions.
function switchPools(node) {
  const id = idWidget(node)?.value || "default";
  for (const pool of connectedPools(node)) {
    const pw = pool.widgets?.find((w) => w.name === "pool_id");
    if (pw) pw.value = id;
    pool._datasetePoolRefresh?.();
    pool.setDirtyCanvas?.(true, true);
  }
  node.setDirtyCanvas?.(true, true);
}

// If the selected profile is empty and a connected pool has images, offer to
// copy those images into the profile (so switching never loses the current pool).
async function maybeSeed(node, entry) {
  const profSlots = await listPoolSlots(entry.id);
  if (profSlots.length > 0) return;                 // profile already has images
  for (const pool of connectedPools(node)) {
    const curId = pool.widgets?.find((w) => w.name === "pool_id")?.value;
    if (!curId || curId === entry.id) continue;
    const curSlots = await listPoolSlots(curId);
    if (curSlots.length === 0) continue;
    if (confirm(`Profile "${entry.name}" is empty. Copy the ${curSlots.length} current pool image(s) into it?`)) {
      try { await postJson("seed", { from: curId, id: entry.id }); }
      catch (err) { alert("Seed failed: " + err); }
    }
    return;                                          // seed from the first match only
  }
}

// user-initiated: set id from the dropdown, optionally offer to seed, then switch
async function selectProfile(node) {
  setIdFromCombo(node);
  const entry = currentEntry(node);
  if (entry) await maybeSeed(node, entry);
  switchPools(node);
}

// programmatic: refresh the dropdown options + hidden id only — never switches
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
  }
  setIdFromCombo(node);
  node.setDirtyCanvas?.(true, true);
}

// ---- actions ----------------------------------------------------------------

async function actionCreate(node) {
  const name = prompt("New profile name:");
  if (!name) return;
  try {
    const e = await postJson("create", { name });
    await refreshList(node, e.name);
    await selectProfile(node);     // new profile is empty → offer to seed current pool
  } catch (err) { alert("Create failed: " + err); }
}

async function actionRename(node) {
  const e = currentEntry(node);
  if (!e) return alert("Select a profile first");
  const name = prompt("Rename profile:", e.name);
  if (!name || name === e.name) return;
  try {
    await postJson("rename", { id: e.id, name });
    await refreshList(node, name);   // same id, no pool switch needed
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
    await selectProfile(node);       // already has images → maybeSeed no-ops, just switch
  } catch (err) { alert("Duplicate failed: " + err); }
}

async function actionDelete(node) {
  const e = currentEntry(node);
  if (!e) return alert("Select a profile first");
  if (!confirm(`Delete profile "${e.name}"? This removes its images.`)) return;
  try {
    await postJson("delete", { id: e.id });
    await refreshList(node);          // update dropdown; leave the pool as-is
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
      await selectProfile(node);     // imported profile has images → just switch
    } catch (err) { alert("Import failed: " + err); }
  };
  input.click();
}

// ---- node setup -------------------------------------------------------------

function setupProfileNode(node) {
  hideWidget(idWidget(node));
  // combo callback = active user selection → switch (and maybe seed)
  replaceWithCombo(node, "profile", [], () => { selectProfile(node); });

  node.addWidget("button", "➕ Create", null, () => actionCreate(node));
  node.addWidget("button", "✎ Rename", null, () => actionRename(node));
  node.addWidget("button", "⧉ Duplicate", null, () => actionDuplicate(node));
  node.addWidget("button", "🗑 Delete", null, () => actionDelete(node));
  node.addWidget("button", "⬇ Export", null, () => actionExport(node));
  node.addWidget("button", "⬆ Import", null, () => actionImport(node));

  node.setSize(node.computeSize());
  refreshList(node);   // populate the dropdown; does NOT switch any pool
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

    // on load the pool already has its saved pool_id, so just refresh the
    // dropdown to show the saved name — no switching, no seeding.
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      const node = this;
      queueMicrotask(() => refreshList(node, profileWidget(node)?.value));
      return r;
    };
    // NOTE: intentionally no onConnectionsChange handler — connecting a profile
    // must never change the pool (the user switches via the dropdown).
  },
});
