import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// Image Gate (Manual Router) — pauses a running prompt, shows the image with N
// labeled route buttons + an Edit-mask + a Stop button, and routes the image down
// the clicked output (others ExecutionBlocker-ed server-side). The Python node
// blocks in run() on GateBus.wait(); this extension renders the preview that the
// server pushes via the "datasete-gate-show" socket event and POSTs the choice.

const NODE = "ImageGate";
const MAX_ROUTES = 10;
const R = "/datasete_gate";

const PREVIEW_IMG_H = 240;   // fixed image area (object-fit:contain)
const BTN_ROW_H = 64;        // buttons area (route buttons wrap + mask/stop)
const MARGIN = 10;           // ComfyUI DOM-widget inset, matches the pool node

// ---- routes widget + label store -------------------------------------------

function routesWidget(node) {
  return node.widgets?.find((w) => w.name === "routes");
}

function getRouteCount(node) {
  let n = parseInt(routesWidget(node)?.value ?? 2, 10);
  if (isNaN(n)) n = 2;
  return Math.max(1, Math.min(MAX_ROUTES, n));
}

// Labels live in node.properties (litegraph serializes properties for free, so
// they survive reload without a fake serializing widget — route_labels is not a
// backend input, so we must NOT push it into widgets_values).
function labelStore(node) {
  if (!Array.isArray(node.properties.routeLabels)) node.properties.routeLabels = [];
  return node.properties.routeLabels;
}

function labelFor(node, route) {     // route is 1-based
  const v = labelStore(node)[route - 1];
  return (v != null && String(v).trim()) || String(route);
}

function setRouteLabel(node, route, text) {
  labelStore(node)[route - 1] = text;
  applyOutputLabels(node);
  if (node._gateActive) renderButtons(node);   // live-update visible buttons
  node.setDirtyCanvas?.(true, true);
}

// ---- dynamic route outputs --------------------------------------------------
// Slot 0 is the always-visible `mask` output; slots 1..N are route_1..route_N.
// We only ever add/remove from the TAIL so existing slot indices (and the
// backend's index→RETURN_TYPES mapping) stay stable and connections are kept.

function applyOutputLabels(node) {
  for (let i = 1; i < node.outputs.length; i++) {
    node.outputs[i].label = labelFor(node, i);
  }
}

function applyRouteCount(node, n) {
  if (!node.outputs || node.outputs.length === 0) return;
  let cur = node.outputs.length - 1;           // current route outputs
  while (cur < n) { node.addOutput(`route_${cur + 1}`, "IMAGE"); cur++; }
  while (cur > n) { node.removeOutput(node.outputs.length - 1); cur--; }
  applyOutputLabels(node);
  node.setDirtyCanvas?.(true, true);
}

// ---- server calls -----------------------------------------------------------

async function postChoice(node, message) {
  const fd = new FormData();
  fd.append("id", String(node.id));
  fd.append("message", String(message));
  await api.fetchApi(`${R}/choice`, { method: "POST", body: fd });
}

async function postMask(node, blob) {
  const fd = new FormData();
  fd.append("id", String(node.id));
  fd.append("mask", blob, "mask.png");
  await api.fetchApi(`${R}/mask`, { method: "POST", body: fd });
}

// ---- preview DOM widget -----------------------------------------------------

function previewHeight(node) {
  return node._gateActive ? 2 * MARGIN + PREVIEW_IMG_H + BTN_ROW_H : 0;
}

function resizePreview(node) {
  if (node._previewWidget) node._previewWidget.computedHeight = previewHeight(node);
  const w = node.size?.[0] || 220;
  node.setSize([w, node.computeSize()[1]]);
  node.setDirtyCanvas(true, true);
}

function renderButtons(node) {
  const { btns } = node._gate;
  btns.innerHTML = "";
  const routes = node._gateRoutes || getRouteCount(node);
  for (let i = 1; i <= routes; i++) {
    const b = document.createElement("button");
    b.className = "dgate-route";
    b.textContent = labelFor(node, i);
    b.onclick = async () => { await postChoice(node, i); hidePreview(node); };
    btns.appendChild(b);
  }
  const edit = document.createElement("button");
  edit.className = "dgate-edit";
  edit.textContent = "🖌 Edit mask";
  edit.onclick = () => openMaskEditor(node);
  btns.appendChild(edit);

  const stop = document.createElement("button");
  stop.className = "dgate-stop";
  stop.textContent = "■ Stop";
  stop.onclick = async () => { await postChoice(node, "__cancel__"); hidePreview(node); };
  btns.appendChild(stop);
}

function showPreview(node, b64, routes) {
  node._gateActive = true;
  node._gateRoutes = Math.max(1, Math.min(MAX_ROUTES, parseInt(routes, 10) || getRouteCount(node)));
  node._previewB64 = b64;
  node._gate.img.src = `data:image/png;base64,${b64}`;
  renderButtons(node);
  resizePreview(node);
}

function hidePreview(node) {
  node._gateActive = false;
  node._previewB64 = null;
  if (node._gate) {
    node._gate.img.removeAttribute("src");
    node._gate.btns.innerHTML = "";
  }
  resizePreview(node);
}

// ---- mask editor (reuses ComfyUI MaskEditor, like the pool node) ------------
// The preview arrives as base64 (no server file), so upload it to input/ first,
// point the MaskEditor at it, then poll node.images for the saved clipspace ref.

function b64ToBlob(b64, type) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type });
}

function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(blob);
  });
}

function comfyAppClass() {
  try { return app.constructor; } catch (e) { return null; }
}

// MaskEditor registers the painted image as this node's output; clear those
// stores so nothing repopulates node.imgs (we draw our own preview).
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

function cleanupMaskState(node) {
  if (node._maskPoll) { clearInterval(node._maskPoll); node._maskPoll = null; }
  node._maskActive = false;
  try {
    node.images = undefined;
    node.previewMediaType = undefined;
  } catch (e) { /* best effort */ }
  clearNodeOutputs(node);
  node.setDirtyCanvas?.(true, true);
}

async function uploadPreview(node) {
  const blob = b64ToBlob(node._previewB64, "image/png");
  const fd = new FormData();
  fd.append("image", blob, `gate_${node.id}.png`);
  fd.append("subfolder", "datasete_gate");
  fd.append("type", "input");
  fd.append("overwrite", "true");
  const res = await api.fetchApi("/upload/image", { method: "POST", body: fd });
  const j = await res.json();
  return { filename: j.name, subfolder: j.subfolder || "datasete_gate", type: j.type || "input" };
}

async function captureMask(node, ref) {
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
    // MaskEditor stores the mask in the ALPHA channel; painted areas come through
    // as alpha 0, so invert (255 - a) into grayscale -> white = painted (MASK).
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3];
      px[i] = px[i + 1] = px[i + 2] = 255 - a;
      px[i + 3] = 255;
    }
    ctx.putImageData(d, 0, 0);
    const maskBlob = await new Promise((res) => c.toBlob(res, "image/png"));
    await postMask(node, maskBlob);
  } catch (e) {
    console.error("[dgate] mask capture failed", e);
  } finally {
    cleanupMaskState(node);
  }
}

async function openMaskEditor(node) {
  if (!node._previewB64) return;
  cleanupMaskState(node);
  let ref;
  try {
    ref = await uploadPreview(node);
  } catch (e) {
    console.error("[dgate] preview upload failed", e);
    return;
  }

  node.images = [ref];
  node.previewMediaType = "image";
  node.imageIndex = 0;
  node._maskActive = true;

  const Comfy = comfyAppClass();
  try { if (Comfy) Comfy.clipspace_return_node = node; } catch (e) { /* ignore */ }

  // No save callback in frontend 1.45 — poll for the editor writing clipspace.
  let waited = 0;
  node._maskPoll = setInterval(() => {
    waited += 300;
    const r = node.images && node.images[0];
    if (node._maskActive && r && r.subfolder === "clipspace") {
      clearInterval(node._maskPoll); node._maskPoll = null;
      captureMask(node, r);
    } else if (waited > 10 * 60 * 1000) {
      cleanupMaskState(node);
    }
  }, 300);

  try { app.canvas?.selectNode?.(node); } catch (e) { /* ignore */ }
  const cmd = app.extensionManager?.command;
  if (cmd?.execute) {
    cmd.execute("Comfy.MaskEditor.OpenMaskEditor");
  } else if (Comfy?.open_maskeditor) {
    Comfy.open_maskeditor();
  } else {
    console.error("[dgate] no MaskEditor entry point found");
    cleanupMaskState(node);
  }
}

// ---- styles + node setup ----------------------------------------------------

function injectStyles() {
  if (document.getElementById("dgate-styles")) return;
  const css = `
  .dgate-wrap { display:flex; flex-direction:column; gap:6px; box-sizing:border-box;
                height:100%; min-height:0; }
  .dgate-img { width:100%; height:${PREVIEW_IMG_H}px; object-fit:contain; display:block;
               background:rgba(0,0,0,0.25); border-radius:4px; }
  .dgate-btns { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
  .dgate-btns button { font-size:12px; padding:3px 10px; cursor:pointer; border-radius:3px;
                       border:1px solid #555; color:#fff; }
  .dgate-route { background:rgba(40,90,140,0.9); }
  .dgate-route:hover { background:rgba(60,120,180,0.95); }
  .dgate-edit { background:rgba(40,40,40,0.9); margin-left:auto; }
  .dgate-stop { background:rgba(160,40,40,0.9); }
  `;
  const style = document.createElement("style");
  style.id = "dgate-styles";
  style.textContent = css;
  document.head.appendChild(style);
}

function setupGateNode(node) {
  injectStyles();

  // Never let the MaskEditor's source image render as an output preview on us —
  // we draw the preview ourselves in the DOM widget below.
  try {
    Object.defineProperty(node, "imgs", {
      configurable: true,
      get() { return undefined; },
      set() { /* suppress */ },
    });
  } catch (e) { /* ignore */ }

  const wrap = document.createElement("div");
  wrap.className = "dgate-wrap";
  const img = document.createElement("img");
  img.className = "dgate-img";
  const btns = document.createElement("div");
  btns.className = "dgate-btns";
  wrap.appendChild(img);
  wrap.appendChild(btns);
  node._gate = { wrap, img, btns };

  node._previewWidget = node.addDOMWidget("gate_preview", "div", wrap, {
    serialize: false,
    getMinHeight: () => previewHeight(node),
  });

  // sync visible route outputs to the routes widget, now and on change
  applyRouteCount(node, getRouteCount(node));
  const rw = routesWidget(node);
  if (rw) {
    const prev = rw.callback;
    rw.callback = function () {
      const r = prev?.apply(this, arguments);
      applyRouteCount(node, getRouteCount(node));
      return r;
    };
  }

  node._gateActive = false;
  resizePreview(node);
}

app.registerExtension({
  name: "datasete.gates.imagegate",

  // one global socket listener: route the server's pause event to the node
  setup() {
    api.addEventListener("datasete-gate-show", (e) => {
      const d = e.detail || {};
      const node = app.graph?.getNodeById?.(parseInt(d.id, 10));
      if (!node || node.type !== NODE) return;
      showPreview(node, d.image, d.routes);
    });
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      setupGateNode(this);
      return r;
    };

    // loaded workflows restore the routes widget + properties after create —
    // re-sync output count/labels to match.
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      if (this.outputs) {
        applyRouteCount(this, getRouteCount(this));
      }
      return r;
    };

    // per-route "Rename…" entries (editable labels, persisted in properties)
    const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
      const r = getExtraMenuOptions?.apply(this, arguments);
      const node = this;
      const routes = getRouteCount(node);
      for (let i = 1; i <= routes; i++) {
        options.push({
          content: `Rename route ${i} (“${labelFor(node, i)}”)…`,
          callback: () => {
            const text = prompt(`Label for route ${i}:`, labelFor(node, i));
            if (text != null) setRouteLabel(node, i, text);
          },
        });
      }
      return r;
    };
  },
});
