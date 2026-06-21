import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// Text Gate (Manual Pass) — pauses a running prompt, shows the incoming text in
// an editable textarea, and on Pass emits the (edited) text. The Python node
// blocks in run() on GateBus.wait_payload(); this extension renders the editor
// the server pushes via the "datasete-textgate-show" socket event and POSTs the
// edited text back. Outputs are static (text, signal) — no dynamic slots.

const NODE = "TextGate";
const R = "/datasete_text_gate";

const EDITOR_H = 160;   // textarea area height
const BTN_ROW_H = 36;   // Pass button row
const MARGIN = 10;      // ComfyUI DOM-widget inset, matches the other gate nodes

// ---- server call ------------------------------------------------------------

async function postPass(node, text) {
  const fd = new FormData();
  fd.append("id", String(node.id));
  fd.append("text", text);
  await api.fetchApi(`${R}/pass`, { method: "POST", body: fd });
}

// ---- preview DOM widget -----------------------------------------------------

function previewHeight(node) {
  return node._tgActive ? 2 * MARGIN + EDITOR_H + BTN_ROW_H : 0;
}

function resizePreview(node) {
  // Fully remove the editor from layout when idle so it never paints below the
  // node frame (collapsing height to 0 alone wouldn't clip the textarea).
  if (node._tg) node._tg.wrap.style.display = node._tgActive ? "flex" : "none";
  const w = node.size?.[0] || 240;
  node.setSize([w, node.computeSize()[1]]);
  node.setDirtyCanvas(true, true);
}

function showEditor(node, text) {
  node._tgActive = true;
  node._tg.area.value = text || "";
  resizePreview(node);
  try { node._tg.area.focus(); } catch (e) { /* ignore */ }
}

function hideEditor(node) {
  node._tgActive = false;
  if (node._tg) node._tg.area.value = "";
  resizePreview(node);
}

// ---- styles + node setup ----------------------------------------------------

function injectStyles() {
  if (document.getElementById("tgate-styles")) return;
  const css = `
  .tgate-wrap { display:flex; flex-direction:column; gap:6px; box-sizing:border-box;
                height:100%; min-height:0; }
  .tgate-area { flex:1 1 auto; min-height:0; width:100%; box-sizing:border-box; resize:none;
                font-size:12px; line-height:1.4; padding:6px; border-radius:4px;
                border:1px solid #555; background:rgba(0,0,0,0.25); color:#fff;
                font-family:ui-monospace, monospace; overflow:auto; }
  .tgate-btns { display:flex; gap:6px; align-items:center; flex:0 0 auto; }
  .tgate-btns button { font-size:12px; padding:3px 14px; cursor:pointer; border-radius:3px;
                       border:1px solid #555; color:#fff; }
  .tgate-pass { background:rgba(40,130,70,0.95); }
  .tgate-pass:hover { background:rgba(55,160,90,0.98); }
  `;
  const style = document.createElement("style");
  style.id = "tgate-styles";
  style.textContent = css;
  document.head.appendChild(style);
}

function setupTextGateNode(node) {
  injectStyles();

  const wrap = document.createElement("div");
  wrap.className = "tgate-wrap";

  const area = document.createElement("textarea");
  area.className = "tgate-area";
  area.placeholder = "waiting for a run…";
  // don't let typing/space toggle node selection or graph shortcuts
  area.onkeydown = (e) => e.stopPropagation();

  const btns = document.createElement("div");
  btns.className = "tgate-btns";
  const pass = document.createElement("button");
  pass.className = "tgate-pass";
  pass.textContent = "▶ Pass";
  pass.onclick = async () => {
    await postPass(node, area.value);
    hideEditor(node);
  };
  btns.appendChild(pass);

  wrap.appendChild(area);
  wrap.appendChild(btns);
  node._tg = { wrap, area, btns };

  node._previewWidget = node.addDOMWidget("textgate_editor", "div", wrap, {
    serialize: false,
    getMinHeight: () => previewHeight(node),
  });

  node._tgActive = false;
  resizePreview(node);
}

app.registerExtension({
  name: "datasete.gates.textgate",

  // one global socket listener: route the server's pause event to the node
  setup() {
    api.addEventListener("datasete-textgate-show", (e) => {
      const d = e.detail || {};
      const node = app.graph?.getNodeById?.(parseInt(d.id, 10));
      if (!node || node.type !== NODE) return;
      showEditor(node, d.text);
    });
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      setupTextGateNode(this);
      return r;
    };
  },
});
