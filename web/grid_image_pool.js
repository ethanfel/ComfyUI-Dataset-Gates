import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// Image Pool (Grid) — in-node grid of pooled images with one selectable as the
// node output. The pool itself lives server-side under input/grid_pool/<pool_id>/;
// this extension just renders thumbnails and mutates the pool via /grid_pool/* routes.

const NODE = "GridImagePool";
const R = "/grid_pool";

// grid geometry (kept in sync with the CSS below) — used to size the node so
// the DOM widget never clips the toolbar and the node auto-grows with content.
const CELL = 96;     // .gip-cell width/height
const GAP = 6;       // .gip-grid gap
const PAD = 4;       // .gip-grid padding
const TOOLBAR_H = 26;
const ROW_H = CELL + GAP;
const MAX_ROWS = 4;  // beyond this the grid scrolls internally
const MIN_W = 280;
// ComfyUI insets DOM widgets by DEFAULT_MARGIN (10px) on every side and forces
// our element to h-full/w-full of the (computedHeight - 2*MARGIN) box. Reserve
// that or the grid eats into the toolbar's space.
const MARGIN = 10;

// ---- pool_id helpers --------------------------------------------------------

function poolWidget(node) {
  return node.widgets?.find((w) => w.name === "pool_id");
}

function getPoolId(node) {
  const w = poolWidget(node);
  return (w?.value || "default").trim() || "default";
}

// Hide the pool_id widget: it must still serialize (carries the per-node UUID
// into the saved workflow) but should never be drawn or take vertical space.
// In frontend 1.45 the switch is `widget.hidden` — isWidgetVisible() returns
// false and getVisibleWidgets() filters it out, so it's excluded from both draw
// and layout. (Setting type="hidden" does NOT hide it.) Serialization iterates
// all widgets regardless of `hidden`, so the value is still saved/sent.
function hideWidget(node, w) {
  if (!w) return;
  w.hidden = true;
  w.computeSize = () => [0, -4];
}

// ---- server calls -----------------------------------------------------------

async function listPool(poolId) {
  const res = await api.fetchApi(`${R}/list?pool_id=${encodeURIComponent(poolId)}`);
  return await res.json();
}

async function addImage(node, blob, filename = "image.png") {
  const fd = new FormData();
  fd.append("pool_id", getPoolId(node));
  fd.append("ts", String(Date.now()));
  fd.append("image", blob, filename);
  await api.fetchApi(`${R}/add`, { method: "POST", body: fd });
  await refresh(node);
}

async function postJson(path, body) {
  await api.fetchApi(`${R}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function setActive(node, index) {
  await postJson("active", { pool_id: getPoolId(node), index });
  await refresh(node);
  node.setDirtyCanvas(true, true);
}

async function setLabel(node, index, label) {
  await postJson("label", { pool_id: getPoolId(node), index, label });
}

async function removeSlot(node, index) {
  await postJson("remove", { pool_id: getPoolId(node), index });
  await refresh(node);
  node.setDirtyCanvas(true, true);
}

// ---- rendering --------------------------------------------------------------

function viewUrl(poolId, name, bust) {
  const sub = encodeURIComponent(`grid_pool/${poolId}`);
  return `/view?filename=${encodeURIComponent(name)}&type=input&subfolder=${sub}&r=${bust}`;
}

// Size the DOM widget to its content: ComfyUI reserves exactly this height for
// the grid (below the index widget), so the toolbar never gets clipped, and the
// node auto-grows as images are added — capped at MAX_ROWS, after which the grid
// scrolls internally.
function recomputeSize(node, count) {
  const width = Math.max(node.size?.[0] || MIN_W, MIN_W);
  const inner = width - 20;                       // node body padding
  const perRow = Math.max(1, Math.floor((inner - 2 * PAD + GAP) / ROW_H));
  const rows = count > 0 ? Math.ceil(count / perRow) : 1;
  const cap = MAX_ROWS * ROW_H - GAP + 2 * PAD;
  const full = count > 0 ? rows * ROW_H - GAP + 2 * PAD : 56;
  node._gridGridMax = cap;
  node._gridWidgetH = 2 * MARGIN + TOOLBAR_H + 6 + Math.min(full, cap);
}

function applySize(node) {
  if (node._gridEl) node._gridEl.style.maxHeight = `${node._gridGridMax || 300}px`;
  const want = node.computeSize();
  node.setSize([Math.max(node.size?.[0] || MIN_W, MIN_W), want[1]]);
  node.setDirtyCanvas(true, true);
}

async function refresh(node) {
  const grid = node._gridEl;
  if (!grid) return;
  const poolId = getPoolId(node);
  let manifest;
  try {
    manifest = await listPool(poolId);
  } catch (e) {
    grid.innerHTML = `<div class="gip-empty">pool error: ${e}</div>`;
    return;
  }
  const slots = manifest.slots || [];
  const active = manifest.active ?? 0;
  const bust = Date.now();
  grid.innerHTML = "";

  // size the node to fit the (new) content before/while rendering
  recomputeSize(node, slots.length);
  applySize(node);

  if (slots.length === 0) {
    const empty = document.createElement("div");
    empty.className = "gip-empty";
    empty.textContent = "Empty pool — paste, drop, or upload images.";
    grid.appendChild(empty);
    return;
  }

  slots.forEach((slot, i) => {
    const cell = document.createElement("div");
    cell.className = "gip-cell" + (i === active ? " gip-active" : "");

    const thumb = document.createElement("img");
    thumb.className = "gip-thumb";
    thumb.src = viewUrl(poolId, slot.image, bust);
    thumb.title = `#${i}` + (slot.label ? ` — ${slot.label}` : "");
    thumb.onclick = () => setActive(node, i);
    cell.appendChild(thumb);

    // index badge
    const badge = document.createElement("div");
    badge.className = "gip-badge";
    badge.textContent = String(i);
    cell.appendChild(badge);

    // has-mask dot
    if (slot.mask) {
      const dot = document.createElement("div");
      dot.className = "gip-maskdot";
      dot.title = "has mask";
      cell.appendChild(dot);
    }

    // mask button (Phase 2 — wired by the MaskEditor integration)
    const maskBtn = document.createElement("button");
    maskBtn.className = "gip-btn gip-mask";
    maskBtn.textContent = "🖌";
    maskBtn.title = "Edit mask";
    maskBtn.onclick = (e) => {
      e.stopPropagation();
      if (node._openMaskEditorForSlot) node._openMaskEditorForSlot(i);
    };
    cell.appendChild(maskBtn);

    // delete button
    const del = document.createElement("button");
    del.className = "gip-btn gip-del";
    del.textContent = "✕";
    del.title = "Remove";
    del.onclick = (e) => {
      e.stopPropagation();
      removeSlot(node, i);
    };
    cell.appendChild(del);

    // label input
    const label = document.createElement("input");
    label.className = "gip-label";
    label.value = slot.label || "";
    label.placeholder = "label…";
    label.onchange = () => setLabel(node, i, label.value);
    // don't let typing/space toggle node selection or graph shortcuts
    label.onkeydown = (e) => e.stopPropagation();
    cell.appendChild(label);

    grid.appendChild(cell);
  });
}

// ---- ingest (paste / drop / upload) ----------------------------------------

function isSelected(node) {
  const sel = app.canvas?.selected_nodes;
  return !!(sel && sel[node.id]);
}

async function ingestFiles(node, files) {
  for (const f of files) {
    if (f && f.type && f.type.startsWith("image/")) {
      await addImage(node, f, f.name || "upload.png");
    }
  }
}

function wireIngest(node, container, uploadBtn, fileInput) {
  // drop onto the grid container
  container.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    container.classList.add("gip-dragover");
  });
  container.addEventListener("dragleave", () => container.classList.remove("gip-dragover"));
  container.addEventListener("drop", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    container.classList.remove("gip-dragover");
    if (e.dataTransfer?.files?.length) await ingestFiles(node, e.dataTransfer.files);
  });

  // upload button -> hidden file input
  uploadBtn.onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    if (fileInput.files?.length) await ingestFiles(node, fileInput.files);
    fileInput.value = "";
  };

  // paste anywhere while this node is selected
  const onPaste = async (e) => {
    if (!isSelected(node)) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of items) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const blob = it.getAsFile();
        if (blob) {
          e.preventDefault();
          await addImage(node, blob, "paste.png");
        }
      }
    }
  };
  document.addEventListener("paste", onPaste);
  // clean up the global listener when the node is removed
  const onRemoved = node.onRemoved;
  node.onRemoved = function () {
    document.removeEventListener("paste", onPaste);
    return onRemoved?.apply(this, arguments);
  };
}

// ---- node setup -------------------------------------------------------------

function injectStyles() {
  if (document.getElementById("gip-styles")) return;
  const css = `
  /* wrap is forced to height:100% (h-full) of the ComfyUI dom-widget box */
  .gip-wrap { display:flex; flex-direction:column; gap:4px; box-sizing:border-box;
              height:100%; min-height:0; }
  /* fixed header — must never shrink/clip, hence flex:0 0 auto */
  .gip-toolbar { display:flex; gap:6px; align-items:center; flex:0 0 auto;
                 min-height:${TOOLBAR_H - 2}px; }
  .gip-toolbar button { font-size:11px; padding:2px 8px; cursor:pointer; }
  .gip-count { font-size:11px; opacity:0.7; margin-left:auto; }
  /* scrolling body — takes the remaining space and scrolls past it */
  .gip-grid { display:flex; flex-wrap:wrap; gap:${GAP}px; overflow-y:auto; align-content:flex-start;
              padding:${PAD}px; background:rgba(0,0,0,0.15); border-radius:4px;
              flex:1 1 auto; min-height:0; }
  .gip-grid.gip-dragover { outline:2px dashed #6cf; outline-offset:-2px; }
  .gip-empty { font-size:12px; opacity:0.6; padding:12px; width:100%; text-align:center; }
  .gip-cell { position:relative; width:96px; height:96px; border:2px solid transparent;
              border-radius:4px; overflow:hidden; background:#222; }
  .gip-cell.gip-active { border-color:#6cf; }
  .gip-thumb { width:100%; height:76px; object-fit:cover; display:block; cursor:pointer; }
  .gip-badge { position:absolute; top:2px; left:2px; font-size:10px; background:rgba(0,0,0,0.6);
               color:#fff; padding:0 4px; border-radius:3px; pointer-events:none; }
  .gip-maskdot { position:absolute; top:3px; left:50%; transform:translateX(-50%); width:8px; height:8px;
                 border-radius:50%; background:#3c8; box-shadow:0 0 2px #000; pointer-events:none; }
  .gip-btn { position:absolute; top:2px; border:none; color:#fff; font-size:11px; line-height:1;
             width:18px; height:18px; border-radius:3px; cursor:pointer; padding:0; }
  .gip-del { right:2px; background:rgba(180,30,30,0.85); }
  .gip-mask { right:22px; background:rgba(40,40,40,0.85); }
  .gip-label { position:absolute; bottom:0; left:0; width:100%; box-sizing:border-box; border:none;
               font-size:10px; padding:1px 3px; background:rgba(0,0,0,0.6); color:#fff; }
  `;
  const style = document.createElement("style");
  style.id = "gip-styles";
  style.textContent = css;
  document.head.appendChild(style);
}

function setupGridNode(node) {
  injectStyles();

  // pool_id: hide the widget, mint a UUID for brand-new nodes (loaded nodes get
  // their saved id restored by onConfigure, which then re-refreshes).
  const pw = poolWidget(node);
  hideWidget(node, pw);
  if (pw && (!pw.value || pw.value === "default")) {
    pw.value = (crypto.randomUUID && crypto.randomUUID()) || `p_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  }

  // build DOM
  const wrap = document.createElement("div");
  wrap.className = "gip-wrap";

  // grid first (top), toolbar last (bottom) — ComfyUI convention puts action
  // buttons at the bottom of the node.
  const grid = document.createElement("div");
  grid.className = "gip-grid";
  wrap.appendChild(grid);

  const toolbar = document.createElement("div");
  toolbar.className = "gip-toolbar";
  const uploadBtn = document.createElement("button");
  uploadBtn.textContent = "⬆ Upload";
  const refreshBtn = document.createElement("button");
  refreshBtn.textContent = "⟳";
  refreshBtn.title = "Refresh";
  refreshBtn.onclick = () => refresh(node);
  const count = document.createElement("span");
  count.className = "gip-count";
  toolbar.appendChild(uploadBtn);
  toolbar.appendChild(refreshBtn);
  toolbar.appendChild(count);
  wrap.appendChild(toolbar);

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.multiple = true;
  fileInput.accept = "image/*";
  fileInput.style.display = "none";
  wrap.appendChild(fileInput);

  node._gridEl = grid;
  node._countEl = count;

  const gridWidget = node.addDOMWidget("grid", "div", wrap, { serialize: false });
  // drive the node height from content so the toolbar never clips
  gridWidget.computeSize = (width) => [width, node._gridWidgetH || 200];

  wireIngest(node, grid, uploadBtn, fileInput);

  // a refresh that also updates the count label
  node._gridRefresh = async () => {
    await refresh(node);
    const n = node._gridEl?.querySelectorAll(".gip-cell").length || 0;
    if (node._countEl) node._countEl.textContent = `${n} image${n === 1 ? "" : "s"}`;
  };

  // initial width + content-driven height
  recomputeSize(node, 0);
  node.setSize([Math.max(node.size?.[0] || 0, MIN_W), node.computeSize()[1]]);

  node._gridRefresh();
}

app.registerExtension({
  name: "datasete.gates.imagepool",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      setupGridNode(this);
      return r;
    };

    // loaded workflows restore pool_id after onNodeCreated — re-refresh then
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      if (this._gridRefresh) this._gridRefresh();
      return r;
    };
  },
});
