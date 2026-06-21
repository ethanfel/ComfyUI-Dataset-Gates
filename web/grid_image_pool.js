import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// Image Pool (Grid) — in-node grid of pooled images with one selectable as the
// node output. The pool itself lives server-side under input/grid_pool/<pool_id>/;
// this extension just renders thumbnails and mutates the pool via /grid_pool/* routes.

const NODE = "GridImagePool";
const R = "/grid_pool";

// grid geometry (kept in sync with the CSS below) — used to size the node so
// the DOM widget never clips the toolbar and the node auto-grows with content.
const CELL = 96;     // .gip-cell width/height (thumbnail size)
const GAP = 6;       // .gip-grid gap
const PAD = 4;       // .gip-grid padding
const TOOLBAR_H = 26;
const ROW_H = CELL + GAP;
const MAX_ROWS = 4;  // beyond this the grid scrolls internally
const COLS = 4;      // fixed column count
const MIN_W = 560;   // minimum node/grid width (the grey area)
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

function newPoolId() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
    `p_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

async function reorderSlots(node, from, to) {
  const n = (node._slots || []).length;
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) return;
  const order = Array.from({ length: n }, (_, k) => k);
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  await postJson("reorder", { pool_id: getPoolId(node), order });
  await refresh(node);
  node.setDirtyCanvas(true, true);
}

// ---- rendering --------------------------------------------------------------

function viewUrl(poolId, name, bust) {
  const sub = encodeURIComponent(`grid_pool/${poolId}`);
  return `/view?filename=${encodeURIComponent(name)}&type=input&subfolder=${sub}&r=${bust}`;
}

// Lay the grid out as N fixed-width columns (N from the `columns` widget) and
// size the node to fit them exactly. An explicit column count avoids depending
// on ComfyUI's DOM-widget width tracking, which doesn't reliably follow the node
// width in frontend 1.45 (columns would otherwise collapse on click).
function recomputeSize(node, count) {
  const rows = count > 0 ? Math.ceil(count / COLS) : 1;
  const cap = MAX_ROWS * ROW_H - GAP + 2 * PAD;
  const full = count > 0 ? rows * ROW_H - GAP + 2 * PAD : 56;
  node._gridGridMax = cap;
  node._gridWidgetH = 2 * MARGIN + TOOLBAR_H + 6 + Math.min(full, cap);
  // node width that fits exactly COLS cells: cells + gaps + grid padding + margins
  const content = COLS * CELL + (COLS - 1) * GAP + 2 * PAD;
  node._gridWidthWanted = Math.max(MIN_W, content + 2 * MARGIN);
}

// Resize to the fixed-column width (exact) and content height (grow-only so a
// manual taller resize is respected between content changes).
function resizeToContent(node) {
  const w = node._gridWidthWanted || MIN_W;
  const h = node.computeSize()[1];
  node.setSize([w, Math.max(node.size?.[1] || 0, h)]);
  node.setDirtyCanvas(true, true);
}

// Recompute every refresh; physically resize only when the image count changes —
// never on a plain select or label edit.
function maybeResize(node, count) {
  recomputeSize(node, count);
  if (count !== node._lastCount) {
    node._lastCount = count;
    requestAnimationFrame(() => resizeToContent(node));
  }
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

  // stash for the mask-editor button (needs the slot's image filename + pool id)
  node._slots = slots;
  node._poolId = poolId;

  // keep computeSize current; only physically resize when the count changes
  maybeResize(node, slots.length);

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

    // drag-to-reorder: the thumbnail is the drag handle, the cell is the target
    cell.ondragover = (e) => {
      if (node._dragFrom == null) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      cell.classList.add("gip-drop");
    };
    cell.ondragleave = () => cell.classList.remove("gip-drop");
    cell.ondrop = (e) => {
      if (node._dragFrom == null) return;
      e.preventDefault();
      e.stopPropagation();
      cell.classList.remove("gip-drop");
      const from = node._dragFrom;
      node._dragFrom = null;
      reorderSlots(node, from, i);
    };

    const thumb = document.createElement("img");
    thumb.className = "gip-thumb";
    thumb.src = viewUrl(poolId, slot.image, bust);
    thumb.title = `#${i}` + (slot.label ? ` — ${slot.label}` : "");
    thumb.onclick = () => setActive(node, i);
    thumb.draggable = true;
    thumb.ondragstart = (e) => {
      node._dragFrom = i;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(i));
    };
    thumb.ondragend = () => { node._dragFrom = null; };
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

// ---- mask editor (Phase 2) --------------------------------------------------
// Opens ComfyUI's built-in MaskEditor for a slot and stores the painted mask
// per-slot. Frontend 1.45 exposes no callback, so we point the editor at our
// slot image via node.images, open it through the registered command, and poll
// node.images for the editor's saved clipspace ref on save.

function comfyAppClass() {
  try { return app.constructor; } catch (e) { return null; }
}

function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(blob);
  });
}

// The MaskEditor registers the painted image as this node's *output*. ComfyUI's
// nodeOutputStore is keyed by NodeLocatorId (String(node.id) for root-graph
// nodes, "<graphId>:<id>" inside subgraphs). Clear both the outputs and any
// preview-image entries so nothing repopulates node.imgs.
function clearNodeOutputs(node) {
  try {
    for (const map of [app.nodeOutputs, app.nodePreviewImages]) {
      if (!map) continue;
      for (const k of Object.keys(map)) {
        if (k === String(node.id) || k.endsWith(`:${node.id}`)) delete map[k];
      }
    }
  } catch (e) { /* best effort */ }
}

// drop the transient hints we set so the editor's source image never lingers as
// a preview on our grid node (node.imgs itself is permanently suppressed below)
function cleanupMaskState(node) {
  if (node._maskPoll) { clearInterval(node._maskPoll); node._maskPoll = null; }
  node._maskSlot = null;
  try {
    node.images = undefined;
    node.previewMediaType = undefined;
  } catch (e) { /* best effort */ }
  clearNodeOutputs(node);
  node.setDirtyCanvas?.(true, true);
}

async function captureMask(node, slot, ref) {
  try {
    const sub = ref.subfolder ?? "clipspace";
    const type = ref.type ?? "input";
    const url = `/view?filename=${encodeURIComponent(ref.filename)}&subfolder=${encodeURIComponent(sub)}&type=${encodeURIComponent(type)}&r=${Date.now()}`;
    const resp = await api.fetchApi(url);
    const blob = await resp.blob();
    const img = await blobToImage(blob);
    const c = document.createElement("canvas");
    c.width = img.naturalWidth || img.width;
    c.height = img.naturalHeight || img.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    const px = d.data;
    // MaskEditor stores the mask in the ALPHA channel (opaque = painted). Bake
    // alpha into a grayscale image so the backend (reads mask as L) sees
    // white = painted region of interest. If polarity is reversed in practice,
    // flip to `255 - a` here.
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3];
      px[i] = px[i + 1] = px[i + 2] = a;
      px[i + 3] = 255;
    }
    ctx.putImageData(d, 0, 0);
    const maskBlob = await new Promise((res) => c.toBlob(res, "image/png"));
    const fd = new FormData();
    fd.append("pool_id", getPoolId(node));
    fd.append("index", String(slot));
    fd.append("mask", maskBlob, "mask.png");
    await api.fetchApi(`${R}/set_mask`, { method: "POST", body: fd });
  } catch (e) {
    console.error("[gip] mask capture failed", e);
  } finally {
    cleanupMaskState(node);
    await refresh(node);
  }
}

function openMaskEditorForSlot(node, index) {
  const slot = (node._slots || [])[index];
  if (!slot) return;
  cleanupMaskState(node);

  const poolId = node._poolId || getPoolId(node);
  // server reference the editor will load (no node.imgs -> no preview overlay)
  node.images = [{ filename: slot.image, subfolder: `grid_pool/${poolId}`, type: "input" }];
  node.previewMediaType = "image";
  node.imageIndex = 0;
  node._maskSlot = index;

  const Comfy = comfyAppClass();
  try { if (Comfy) Comfy.clipspace_return_node = node; } catch (e) { /* ignore */ }

  // No save callback in 1.45 — poll for the editor writing the clipspace ref.
  let waited = 0;
  node._maskPoll = setInterval(() => {
    waited += 300;
    const ref = node.images && node.images[0];
    if (node._maskSlot != null && ref && ref.subfolder === "clipspace") {
      const slotIdx = node._maskSlot;
      node._maskSlot = null;
      clearInterval(node._maskPoll); node._maskPoll = null;
      captureMask(node, slotIdx, ref);
    } else if (waited > 10 * 60 * 1000) {
      cleanupMaskState(node);  // safety timeout (user cancelled long ago)
    }
  }, 300);

  // select our node so the command targets it, then open the editor
  try { app.canvas?.selectNode?.(node); } catch (e) { /* ignore */ }
  const cmd = app.extensionManager?.command;
  if (cmd?.execute) {
    cmd.execute("Comfy.MaskEditor.OpenMaskEditor");
  } else if (Comfy?.open_maskeditor) {
    Comfy.open_maskeditor();
  } else {
    console.error("[gip] no MaskEditor entry point found");
    cleanupMaskState(node);
  }
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
  /* scrolling body — explicit N columns (set via --gip-cols / inline style) so
     the layout never depends on the DOM-widget width tracking */
  .gip-grid { display:grid; grid-template-columns:repeat(${COLS}, ${CELL}px); gap:${GAP}px;
              justify-content:start; align-content:start; overflow-y:auto;
              padding:${PAD}px; background:rgba(0,0,0,0.15); border-radius:4px;
              flex:1 1 auto; min-height:0; }
  .gip-grid.gip-dragover { outline:2px dashed #6cf; outline-offset:-2px; }
  .gip-empty { font-size:12px; opacity:0.6; padding:12px; grid-column:1 / -1; text-align:center; }
  .gip-cell { position:relative; width:${CELL}px; height:${CELL}px; border:2px solid transparent;
              border-radius:4px; overflow:hidden; background:#222; transition:border-color .1s; }
  .gip-cell:hover { border-color:#555; }
  .gip-cell.gip-active { border-color:#6cf; }
  .gip-cell.gip-drop { border-color:#fc6; border-style:dashed; }
  .gip-thumb { width:100%; height:${CELL - 20}px; object-fit:cover; display:block; cursor:grab; }
  .gip-thumb:active { cursor:grabbing; }
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
    pw.value = newPoolId();
  }

  // Our node draws its own grid; ComfyUI must never reserve/draw an output-image
  // preview on it. The MaskEditor registers the painted image as this node's
  // output, and the nodeOutputStore's syncLegacyNodeImgs would then set
  // node.imgs — which reserves preview space at the top and shoves the widgets
  // down (the "gap"/detach). Pin node.imgs to undefined so that can't happen.
  // The editor still opens fine via node.images + previewMediaType.
  try {
    Object.defineProperty(node, "imgs", {
      configurable: true,
      get() { return undefined; },
      set() { /* suppress output-image preview */ },
    });
  } catch (e) { /* ignore */ }

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
  node._openMaskEditorForSlot = (i) => openMaskEditorForSlot(node, i);

  // Size the DOM widget through the OPTION ComfyUI's layout actually reads
  // (computeLayoutSize -> getMinHeight). Provide ONLY a min-height floor and NO
  // getMaxHeight, so the grid FILLS the node and grows when the user resizes it.
  // Pinning a max (or overriding widget.computeSize) locks the widget to a fixed
  // size while the node frame keeps resizing — they diverge and the grid appears
  // to detach / stop expanding on click.
  node.addDOMWidget("grid", "div", wrap, {
    serialize: false,
    getMinHeight: () => node._gridWidgetH || 120,
  });

  wireIngest(node, grid, uploadBtn, fileInput);

  // a refresh that also updates the count label
  node._gridRefresh = async () => {
    await refresh(node);
    const n = node._gridEl?.querySelectorAll(".gip-cell").length || 0;
    if (node._countEl) node._countEl.textContent = `${n} image${n === 1 ? "" : "s"}`;
  };

  // ComfyUI snaps the node to computeSize() on selection, and computeSize's WIDTH
  // ignores DOM widgets — it collapses to ~the title/index width, clipping our
  // grid on click. Floor the computed width to the column-fit width so the snap
  // keeps the node wide enough. (Only width is touched; the height path through
  // computeLayoutSize is untouched, so the DOM overlay stays in sync.)
  const origComputeSize = node.computeSize;
  node.computeSize = function (out) {
    const sz = origComputeSize ? origComputeSize.call(this, out) : [MIN_W, 120];
    sz[0] = Math.max(sz[0], node._gridWidthWanted || MIN_W);
    return sz;
  };

  // initial width (fits COLS columns) + content-driven height; the first refresh
  // resizes once if the pool already has images
  node._lastCount = 0;
  recomputeSize(node, 0);
  node.setSize([node._gridWidthWanted || MIN_W, node.computeSize()[1]]);

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

    // right-click "Detach pool (new id)" — a cloned node shares its source's
    // pool_id; this gives it a fresh, independent pool.
    const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
      const r = getExtraMenuOptions?.apply(this, arguments);
      const node = this;
      options.push({
        content: "Detach pool (new id)",
        callback: () => {
          const w = poolWidget(node);
          if (w) w.value = newPoolId();
          node._lastCount = -1;            // force a resize on the next refresh
          if (node._gridRefresh) node._gridRefresh();
        },
      });
      return r;
    };
  },
});
