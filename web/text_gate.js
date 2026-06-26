import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// Text Gate (Manual Pass) — pauses a running prompt, shows the incoming text in
// an editable textarea, and on Pass emits the (edited) text. The Python node
// blocks in run() on GateBus.wait_payload(); this extension renders the editor
// the server pushes via the "datasete-textgate-show" socket event and POSTs the
// edited text back. Outputs are static (text, signal) — no dynamic slots.
//
// After Pass, a "▶ Run from here" button re-queues the prompt (Image Gate
// parity): the gate re-arms every run and IS_CHANGED is NaN, so it re-pauses
// each run. The edited text is sticky by INTENT: a Run-from-here re-queue keeps
// YOUR edited text (even if a non-deterministic upstream regenerates it), while
// a normal toolbar Queue shows whatever the upstream produced. Keying off which
// button ran — not a text comparison — means a random/seeded upstream can't
// clobber the edit on re-run. (Re-queuing still recomputes non-cacheable
// upstream, as in any ComfyUI run; that regenerated text is simply ignored.)
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

// ---- run-from-here + state --------------------------------------------------
// States: "idle" (pre-run), "paused" (waiting for Pass), "passed" (Run-from-here
// shown). Re-queuing the whole prompt is enough to "resume" — cached upstream
// re-pauses the gate, matching the Image Gate's queueFromHere.

async function queueFromHere(node) {
  try {
    await app.queuePrompt(0, 1);
  } catch (e) {
    try { await app.queuePrompt(0); } catch (e2) { console.error("[tgate] queue failed", e2); }
  }
}

function setState(node, s) {
  node._tgState = s;
  const tg = node._tg;
  if (!tg) return;
  tg.pass.style.display = s === "passed" ? "none" : "";
  tg.runHere.style.display = s === "passed" ? "" : "none";
  if (s === "paused") tg.status.textContent = "edit, then Pass";
  else if (s === "passed") tg.status.textContent = "passed — Run from here to re-run";
  node.setDirtyCanvas?.(true, true);
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
  .tgate-run { background:rgba(40,90,140,0.95); }
  .tgate-run:hover { background:rgba(60,120,180,0.98); }
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
  pass.onclick = async () => {
    await postPass(node, area.value);
    setState(node, "passed");
  };

  // Re-queue the prompt; cached upstream re-pauses the gate so you can run your
  // edited text downstream again without recomputing the graph above it.
  const runHere = document.createElement("button");
  runHere.className = "tgate-run";
  runHere.textContent = "▶ Run from here";
  runHere.style.display = "none";
  runHere.onclick = async () => {
    node._tgKeepEdit = true;   // tell the next re-pause to preserve this edit
    node._tg.status.textContent = "re-running…";
    await queueFromHere(node);
  };

  const status = document.createElement("span");
  status.className = "tgate-status";

  btns.appendChild(pass);
  btns.appendChild(runHere);
  btns.appendChild(status);

  wrap.appendChild(area);
  wrap.appendChild(btns);
  node._tg = { wrap, area, status, pass, runHere };
  node._tgState = "idle";

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
      // Sticky edit by intent: a Run-from-here re-queue (the _tgKeepEdit flag)
      // keeps YOUR edited text so the gate re-emits it downstream; a normal
      // Queue shows whatever the upstream produced. Keying off the button —
      // not a text comparison — means a non-deterministic upstream can't
      // clobber the edit on re-run.
      if (node._tgKeepEdit) {
        node._tgKeepEdit = false;
      } else {
        node._tg.area.value = d.text || "";
      }
      setState(node, "paused");
      try { node._tg.area.focus(); } catch (err) { /* ignore */ }
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
