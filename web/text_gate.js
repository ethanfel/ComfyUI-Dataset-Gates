import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// Text Gate (Manual Pass) — pauses a running prompt, shows the incoming text in
// an editable textarea, and on Pass emits the (edited) text. The Python node
// blocks in run() on GateBus.wait_payload(); this extension renders the editor
// the server pushes via the "datasete-textgate-show" socket event and POSTs the
// edited text back. Outputs are static (text, signal) — no dynamic slots.
//
// Sizing follows the Image Pool node: the editor is always present and FILLS the
// node, with only a min-height floor (no max) so the node stays freely resizable
// and the textarea grows with it.

const NODE = "TextGate";
const R = "/datasete_text_gate";

const MIN_W = 320;          // default node width (freely resizable)
const MIN_EDITOR_H = 140;   // textarea floor
const BTN_ROW_H = 34;       // Pass button row
const MARGIN = 10;          // ComfyUI DOM-widget inset, matches the other nodes

// ---- server call ------------------------------------------------------------

async function postPass(node, text) {
  const fd = new FormData();
  fd.append("id", String(node.id));
  fd.append("text", text);
  await api.fetchApi(`${R}/pass`, { method: "POST", body: fd });
}

// ---- sizing (Image Pool pattern) --------------------------------------------

// Only a min-height FLOOR — no max — so the DOM widget fills the node and grows
// when the user resizes it. (A fixed height, or forcing node height on every
// interaction, would lock the node and leave dead grey space below the editor.)
function widgetFloor() {
  return 2 * MARGIN + MIN_EDITOR_H + BTN_ROW_H;
}

// DomWidgets sizes the editor container from the widget width, which can lag
// node.size[0] on this frontend — pin it so the textarea reflows to fill.
function syncWidgetWidth(node) {
  if (node._tgWidget) node._tgWidget.width = node.size?.[0] || MIN_W;
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
  .tgate-status { font-size:11px; opacity:0.6; margin-left:auto; }
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
  const status = document.createElement("span");
  status.className = "tgate-status";
  pass.onclick = async () => {
    await postPass(node, area.value);
    status.textContent = "passed";
  };
  btns.appendChild(pass);
  btns.appendChild(status);

  wrap.appendChild(area);
  wrap.appendChild(btns);
  node._tg = { wrap, area, status };

  // FILLS the node: floor-only min height, no max (Image Pool pattern).
  node._tgWidget = node.addDOMWidget("textgate_editor", "div", wrap, {
    serialize: false,
    getMinHeight: () => widgetFloor(),
  });

  // keep the editor width synced on manual resize so the textarea reflows
  const onResize = node.onResize;
  node.onResize = function () {
    const r = onResize?.apply(this, arguments);
    syncWidgetWidth(node);
    return r;
  };

  // sensible default size; the node stays freely resizable (no width floor lock)
  node.setSize([Math.max(node.size?.[0] || 0, MIN_W), node.computeSize()[1]]);
  syncWidgetWidth(node);
}

app.registerExtension({
  name: "datasete.gates.textgate",

  // one global socket listener: route the server's pause event to the node
  setup() {
    api.addEventListener("datasete-textgate-show", (e) => {
      const d = e.detail || {};
      const node = app.graph?.getNodeById?.(parseInt(d.id, 10));
      if (!node || node.type !== NODE || !node._tg) return;
      node._tg.area.value = d.text || "";
      node._tg.status.textContent = "edit, then Pass";
      try { node._tg.area.focus(); } catch (err) { /* ignore */ }
      node.setDirtyCanvas?.(true, true);
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
