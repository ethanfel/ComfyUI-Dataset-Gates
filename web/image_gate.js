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

const MIN_IMG_H = 140;       // preview image area clamps (scales with node width)
const MAX_IMG_H = 600;
const BTN_ROW_H = 78;        // buttons area (route buttons wrap + actions)
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
  if (node._gateState && node._gateState !== "idle") render(node);  // live-update
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

// ---- preview DOM widget + state machine -------------------------------------
// States: "idle" (collapsed, before the first run), "paused" (waiting for a
// route choice — route buttons shown), "resolved" (a route was picked — image +
// mask kept, a "Run from here" re-queue button shown). The node never blanks
// once a run has happened, so the previewed image and the sticky mask stay for
// context and the painted mask is reused on the next run until cleared.

function computeImgH(node) {
  // image area scales with node WIDTH and the image's aspect ratio, so a wider
  // node shows a bigger preview (getMinHeight is polled each layout frame).
  const w = Math.max(120, (node.size?.[0] || 220) - 2 * MARGIN);
  const h = Math.round(w * (node._imgAspect || 1));
  return Math.max(MIN_IMG_H, Math.min(h, MAX_IMG_H));
}

function previewHeight(node) {
  if (!node._gateState || node._gateState === "idle") return 0;
  return 2 * MARGIN + computeImgH(node) + BTN_ROW_H;
}

// DomWidgets sizes the preview container from the widget width, which can lag
// node.size[0] on this frontend — pin it so the image/buttons reflow to fill.
function syncWidgetWidth(node) {
  if (node._previewWidget) node._previewWidget.width = node.size?.[0] || 220;
}

function resizePreview(node) {
  // Fully remove the preview element from layout when idle — collapsing the
  // widget height to 0 isn't enough: the <img> would still paint below the node.
  const shown = node._gateState && node._gateState !== "idle";
  if (node._gate) node._gate.wrap.style.display = shown ? "flex" : "none";
  const w = node.size?.[0] || 220;
  // Image Pool pattern: grow to fit the content floor but preserve a larger
  // user-set size (so the node stays freely resizable); collapse exactly when
  // idle. Forcing the height on every call would lock the node.
  const target = shown
    ? Math.max(node.size?.[1] || 0, node.computeSize()[1])
    : node.computeSize()[1];
  node.setSize([w, target]);
  syncWidgetWidth(node);
  node.setDirtyCanvas(true, true);
}

function hasMask(node) { return !!node._stickyMask; }

function maskControls(node) {
  // Edit / Clear buttons + a small "mask retained" badge, shared by both states.
  const els = [];
  const edit = document.createElement("button");
  edit.className = "dgate-edit";
  edit.textContent = "🖌 Edit mask";
  edit.onclick = () => openMaskEditor(node);
  els.push(edit);
  if (hasMask(node)) {
    const clr = document.createElement("button");
    clr.className = "dgate-clear";
    clr.textContent = "✕ Clear mask";
    clr.onclick = () => clearMask(node);
    els.push(clr);
  }
  const badge = document.createElement("span");
  badge.className = "dgate-status";
  badge.textContent = hasMask(node) ? "🎭 mask retained" : "no mask";
  badge.style.opacity = hasMask(node) ? "0.9" : "0.45";
  els.push(badge);
  return els;
}

function render(node) {
  const { btns } = node._gate;
  btns.innerHTML = "";
  const routes = node._gateRoutes || getRouteCount(node);

  if (node._gateState === "paused") {
    for (let i = 1; i <= routes; i++) {
      const b = document.createElement("button");
      b.className = "dgate-route";
      b.textContent = labelFor(node, i);
      b.onclick = async () => {
        await postChoice(node, i);
        showResolved(node, labelFor(node, i));
      };
      btns.appendChild(b);
    }
    maskControls(node).forEach((el) => btns.appendChild(el));
    const stop = document.createElement("button");
    stop.className = "dgate-stop";
    stop.textContent = "■ Stop";
    stop.onclick = async () => {
      await postChoice(node, "__cancel__");
      showResolved(node, "stopped");
    };
    btns.appendChild(stop);
  } else if (node._gateState === "resolved") {
    const status = document.createElement("span");
    status.className = "dgate-status";
    status.textContent = `✓ routed to ${node._gateChoice ?? "?"}`;
    btns.appendChild(status);
    const run = document.createElement("button");
    run.className = "dgate-run";
    run.textContent = "▶ Run from here";
    run.onclick = () => queueFromHere(node);
    btns.appendChild(run);
    maskControls(node).forEach((el) => btns.appendChild(el));
  }
  updateMaskOverlay(node);
}

function showPaused(node, b64, routes) {
  node._gateState = "paused";
  node._gateRoutes = Math.max(1, Math.min(MAX_ROUTES, parseInt(routes, 10) || getRouteCount(node)));
  node._previewB64 = b64;
  node._gate.img.src = `data:image/png;base64,${b64}`;
  // sticky mask: re-stash the last painted mask for THIS run before the user
  // picks a route. run() does arm()→clear, then send_preview→this event, then
  // blocks in wait(), so this POST always lands before the choice is made.
  if (node._stickyMask) {
    postMask(node, b64ToBlob(node._stickyMask, "image/png")).catch(() => {});
  }
  render(node);
  resizePreview(node);
}

function showResolved(node, choiceLabel) {
  node._gateState = "resolved";
  node._gateChoice = choiceLabel;
  render(node);
  resizePreview(node);
}

async function queueFromHere(node) {
  try {
    await app.queuePrompt(0, 1);
  } catch (e) {
    try { await app.queuePrompt(0); } catch (e2) { console.error("[dgate] queue failed", e2); }
  }
}

async function clearMask(node) {
  node._stickyMask = null;
  node._stickyMaskOverlay = null;
  // zero the current run's stash: an empty mask part -> server stores b"" ->
  // mask_from_stash() treats it as falsy -> zeros.
  try { await postMask(node, new Blob([], { type: "image/png" })); } catch (e) { /* ignore */ }
  render(node);
}

// ---- mask overlay (show the painted region over the preview, semi-transparent)
// The sticky mask is grayscale (white = painted). Recolor it into an RGBA layer
// where alpha = paint intensity and RGB = a highlight color, so unpainted areas
// are fully transparent and only the painted region tints the image.

function maskToOverlay(b64) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => {
      const c = document.createElement("canvas");
      c.width = im.naturalWidth || im.width;
      c.height = im.naturalHeight || im.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(im, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height);
      const px = d.data;
      for (let i = 0; i < px.length; i += 4) {
        const v = px[i];                        // grayscale luminance (R=G=B)
        px[i] = 255; px[i + 1] = 64; px[i + 2] = 64;   // highlight = red
        px[i + 3] = v;                          // alpha = paint intensity
      }
      ctx.putImageData(d, 0, 0);
      resolve(c.toDataURL("image/png"));
    };
    im.onerror = reject;
    im.src = `data:image/png;base64,${b64}`;
  });
}

async function setStickyMask(node, b64) {
  node._stickyMask = b64;
  try {
    node._stickyMaskOverlay = b64 ? await maskToOverlay(b64) : null;
  } catch (e) {
    node._stickyMaskOverlay = null;
  }
  updateMaskOverlay(node);
}

function updateMaskOverlay(node) {
  const mi = node._gate?.maskImg;
  if (!mi) return;
  if (node._gateState && node._gateState !== "idle" && node._stickyMaskOverlay) {
    mi.src = node._stickyMaskOverlay;
    mi.style.display = "block";
  } else {
    mi.removeAttribute("src");
    mi.style.display = "none";
  }
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

function blobToB64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1] || "");
    fr.onerror = reject;
    fr.readAsDataURL(blob);
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
    // remember it so it auto-applies on the next run until the user clears it,
    // and build the colored overlay shown over the preview.
    try { await setStickyMask(node, await blobToB64(maskBlob)); } catch (e) { /* ignore */ }
  } catch (e) {
    console.error("[dgate] mask capture failed", e);
  } finally {
    cleanupMaskState(node);
    if (node._gateState && node._gateState !== "idle") render(node);  // show badge
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
  .dgate-imgbox { position:relative; flex:1 1 auto; min-height:0; width:100%;
                  background:rgba(0,0,0,0.25); border-radius:4px; overflow:hidden; }
  .dgate-img { position:absolute; inset:0; width:100%; height:100%; object-fit:contain;
               display:block; }
  .dgate-mask { position:absolute; inset:0; width:100%; height:100%; object-fit:contain;
                opacity:0.5; pointer-events:none; }
  .dgate-btns { display:flex; flex-wrap:wrap; gap:6px; align-items:center; flex:0 0 auto; }
  .dgate-btns button { font-size:12px; padding:3px 10px; cursor:pointer; border-radius:3px;
                       border:1px solid #555; color:#fff; }
  .dgate-route { background:rgba(40,90,140,0.9); }
  .dgate-route:hover { background:rgba(60,120,180,0.95); }
  .dgate-edit { background:rgba(40,40,40,0.9); }
  .dgate-clear { background:rgba(90,60,30,0.9); }
  .dgate-run { background:rgba(40,130,70,0.95); }
  .dgate-stop { background:rgba(160,40,40,0.9); margin-left:auto; }
  .dgate-status { font-size:11px; opacity:0.8; padding:0 4px; align-self:center; }
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

  // image + mask overlay share a container so both letterbox identically and
  // stay pixel-aligned (object-fit:contain on same-size, same-aspect layers).
  const imgbox = document.createElement("div");
  imgbox.className = "dgate-imgbox";
  const img = document.createElement("img");
  img.className = "dgate-img";
  // capture the image aspect so the preview area scales with the node width
  img.onload = () => {
    const w = img.naturalWidth || 1;
    const h = img.naturalHeight || 1;
    node._imgAspect = h / w;
    resizePreview(node);
  };
  const maskImg = document.createElement("img");
  maskImg.className = "dgate-mask";
  maskImg.style.display = "none";
  imgbox.appendChild(img);
  imgbox.appendChild(maskImg);

  const btns = document.createElement("div");
  btns.className = "dgate-btns";
  wrap.appendChild(imgbox);
  wrap.appendChild(btns);
  node._gate = { wrap, imgbox, img, maskImg, btns };

  node._previewWidget = node.addDOMWidget("gate_preview", "div", wrap, {
    serialize: false,
    getMinHeight: () => previewHeight(node),
  });

  // keep the preview width synced on manual resize so the image/buttons reflow
  const onResize = node.onResize;
  node.onResize = function () {
    const r = onResize?.apply(this, arguments);
    syncWidgetWidth(node);
    return r;
  };

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

  node._gateState = "idle";
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
      showPaused(node, d.image, d.routes);
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
