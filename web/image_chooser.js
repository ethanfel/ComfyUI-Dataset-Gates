import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// Image Chooser Gate (Batch) — pauses a prompt, displays every image in the
// incoming batch, and resumes with the selected subset as a new IMAGE batch.

const NODE = "ImageChooserGate";
const R = "/datasete_image_chooser";

const MIN_W = 420;
const MIN_GRID_H = 190;
const TOOLBAR_H = 72;
const MARGIN = 10;
const chooserNodes = new Set();

function graphNodeById(graph, id) {
  if (!graph?.getNodeById) return null;
  return graph.getNodeById(id) ?? graph.getNodeById(parseInt(id, 10));
}

function chooserByLocator(locator) {
  const direct = graphNodeById(app.graph, locator);
  if (direct?.type === NODE) return direct;

  // Native subgraphs identify executing nodes as colon-separated locators:
  // root subgraph-node id -> nested node id -> ... -> chooser id.
  let graph = app.rootGraph ?? app.graph?.rootGraph ?? app.graph;
  let node = null;
  for (const id of String(locator).split(":")) {
    node = graphNodeById(graph, id);
    if (!node) return null;
    graph = node.subgraph;
  }
  return node?.type === NODE ? node : null;
}

function widgetFloor(node) {
  return node._icgState === "idle" ? 0 : 2 * MARGIN + MIN_GRID_H + TOOLBAR_H;
}

function syncWidgetWidth(node) {
  if (node._icgWidget) node._icgWidget.width = node.size?.[0] || MIN_W;
}

function resizeChooser(node) {
  const shown = node._icgState !== "idle";
  if (node._icg?.wrap) node._icg.wrap.style.display = shown ? "flex" : "none";
  const width = node.size?.[0] || MIN_W;
  const target = shown
    ? Math.max(node.size?.[1] || 0, node.computeSize()[1])
    : node.computeSize()[1];
  node.setSize([width, target]);
  syncWidgetWidth(node);
  node.setDirtyCanvas?.(true, true);
}

async function postChooser(node, fields) {
  const form = new FormData();
  form.append("id", String(node._icgWaitId ?? node.id));
  form.append("token", String(node._icgToken ?? ""));
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const response = await api.fetchApi(`${R}/select`, { method: "POST", body: form });
  if (!response.ok) throw new Error(`chooser request failed (${response.status})`);
}

async function queueFromHere() {
  const command = app.extensionManager?.command;
  if (command?.execute) {
    try {
      await command.execute("Comfy.QueuePrompt");
      return true;
    } catch (e) { /* use the legacy path below */ }
  }
  try {
    await app.queuePrompt(0, 1);
    return true;
  } catch (e) {
    try {
      await app.queuePrompt(0);
      return true;
    } catch (fallbackError) {
      console.error("[image-chooser] queue failed", fallbackError);
      return false;
    }
  }
}

function selectedIndices(node) {
  return [...node._icgSelected].sort((a, b) => a - b);
}

function updateCells(node) {
  for (const [index, cell] of node._icgCells) {
    const selected = node._icgSelected.has(index);
    cell.classList.toggle("icg-selected", selected);
    cell.setAttribute("aria-pressed", selected ? "true" : "false");
    const check = cell.querySelector(".icg-check");
    if (check) check.textContent = selected ? "✓" : "";
  }
}

function select(node, indices) {
  if (node._icgState !== "paused" || node._icgBusy) return;
  node._icgSelected = new Set(indices);
  node._icgError = "";
  updateCells(node);
  renderToolbar(node);
}

function button(text, className, onclick) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = text;
  element.className = className;
  element.onclick = onclick;
  return element;
}

function renderToolbar(node) {
  const { toolbar } = node._icg;
  toolbar.innerHTML = "";
  const count = node._icgItems.length;
  const chosen = selectedIndices(node);

  if (node._icgState === "paused") {
    const all = button("Select all", "icg-secondary", () => {
      select(node, node._icgItems.map((item) => item.index));
    });
    all.disabled = node._icgBusy || chosen.length === count;

    const clear = button("Clear", "icg-secondary", () => select(node, []));
    clear.disabled = node._icgBusy || chosen.length === 0;

    const pass = button(
      chosen.length ? `▶ Pass selected (${chosen.length})` : "▶ Pass selected",
      "icg-pass",
      async () => {
        if (!chosen.length || node._icgBusy) return;
        const revision = node._icgRevision;
        node._icgBusy = true;
        node._icgError = "";
        renderGridState(node);
        renderToolbar(node);
        try {
          await postChooser(node, { selection: JSON.stringify(chosen) });
          if (node._icgRevision === revision) {
            node._icgState = "resolved";
            node._icgResolvedCount = chosen.length;
          }
        } catch (error) {
          console.error("[image-chooser] pass failed", error);
          if (node._icgRevision === revision) {
            node._icgError = "Could not pass the selection";
          }
        } finally {
          if (node._icgRevision !== revision) return;
          node._icgBusy = false;
          renderGridState(node);
          renderToolbar(node);
          resizeChooser(node);
        }
      },
    );
    pass.disabled = node._icgBusy || chosen.length === 0;

    const stop = button("■ Stop", "icg-stop", async () => {
      if (node._icgBusy) return;
      const revision = node._icgRevision;
      node._icgBusy = true;
      node._icgError = "";
      renderGridState(node);
      renderToolbar(node);
      try {
        await postChooser(node, { action: "cancel" });
        if (node._icgRevision === revision) {
          node._icgState = "resolved";
          node._icgStopped = true;
        }
      } catch (error) {
        console.error("[image-chooser] stop failed", error);
        if (node._icgRevision === revision) {
          node._icgError = "Could not stop the run";
        }
      } finally {
        if (node._icgRevision !== revision) return;
        node._icgBusy = false;
        renderGridState(node);
        renderToolbar(node);
      }
    });
    stop.disabled = node._icgBusy;

    const status = document.createElement("span");
    status.className = `icg-status${node._icgError ? " icg-error" : ""}`;
    status.textContent = node._icgError || (node._icgBusy
      ? "sending…"
      : `${chosen.length} of ${count} selected`);

    toolbar.appendChild(all);
    toolbar.appendChild(clear);
    toolbar.appendChild(pass);
    toolbar.appendChild(status);
    toolbar.appendChild(stop);
  } else if (node._icgState === "resolved") {
    const status = document.createElement("span");
    status.className = `icg-status icg-resolved${node._icgError ? " icg-error" : ""}`;
    status.textContent = node._icgError || (node._icgQueueBusy
      ? "queuing…"
      : node._icgStopped
        ? "■ run stopped"
        : `✓ passed ${node._icgResolvedCount} of ${count}`);
    const run = button("▶ Run from here", "icg-run", async () => {
      if (node._icgQueueBusy) return;
      node._icgQueueBusy = true;
      node._icgError = "";
      renderToolbar(node);
      if (!await queueFromHere()) {
        node._icgQueueBusy = false;
        node._icgError = "Could not queue the workflow";
        renderToolbar(node);
      }
    });
    run.disabled = node._icgQueueBusy;
    toolbar.appendChild(status);
    toolbar.appendChild(run);
  }
}

function renderGridState(node) {
  const editable = node._icgState === "paused" && !node._icgBusy;
  for (const cell of node._icgCells.values()) cell.disabled = !editable;
  updateCells(node);
}

function toggleImage(node, index) {
  if (node._icgState !== "paused" || node._icgBusy) return;
  const next = new Set(node._icgSelected);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  select(node, next);
}

function renderGrid(node) {
  const { grid } = node._icg;
  grid.innerHTML = "";
  node._icgCells = new Map();

  for (const item of node._icgItems) {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "icg-cell";
    cell.title = `Image ${item.index + 1} — ${item.width}×${item.height}`;
    cell.setAttribute("aria-label", `Select image ${item.index + 1}`);
    cell.onclick = () => toggleImage(node, item.index);

    const image = document.createElement("img");
    image.className = "icg-thumb";
    image.alt = `Batch image ${item.index + 1}`;
    image.draggable = false;
    image.src = `data:image/jpeg;base64,${item.image}`;

    const badge = document.createElement("span");
    badge.className = "icg-badge";
    badge.textContent = String(item.index + 1);

    const dimensions = document.createElement("span");
    dimensions.className = "icg-dimensions";
    dimensions.textContent = `${item.width}×${item.height}`;

    const check = document.createElement("span");
    check.className = "icg-check";

    cell.appendChild(image);
    cell.appendChild(badge);
    cell.appendChild(dimensions);
    cell.appendChild(check);
    grid.appendChild(cell);
    node._icgCells.set(item.index, cell);
  }
  renderGridState(node);
}

function showBatch(node, waitId, token, items) {
  node._icgRevision += 1;
  node._icgWaitId = waitId;
  node._icgToken = token;
  node._icgItems = Array.isArray(items) ? items : [];
  node._icgSelected = new Set();
  node._icgBusy = false;
  node._icgError = "";
  node._icgStopped = false;
  node._icgResolvedCount = 0;
  node._icgQueueBusy = false;
  node._icgState = "paused";
  renderGrid(node);
  renderToolbar(node);
  resizeChooser(node);
}

function injectStyles() {
  if (document.getElementById("icg-styles")) return;
  const css = `
  .icg-wrap { display:flex; flex-direction:column; gap:7px; box-sizing:border-box;
              height:100%; min-height:0; }
  .icg-grid { flex:1 1 auto; min-height:0; overflow:auto; display:grid;
              grid-template-columns:repeat(auto-fill,minmax(108px,1fr));
              grid-auto-rows:max-content; gap:7px; align-content:start; padding:2px; }
  .icg-cell { position:relative; aspect-ratio:1; min-width:0; overflow:hidden; padding:0;
              border:2px solid transparent; border-radius:5px; background:#1d1d1d;
              cursor:pointer; transition:border-color .1s, box-shadow .1s; }
  .icg-cell:hover:not(:disabled) { border-color:#777; }
  .icg-cell:disabled { cursor:default; opacity:1; }
  .icg-cell.icg-selected { border-color:#55d78a; box-shadow:0 0 0 1px #55d78a; }
  .icg-thumb { position:absolute; inset:0; width:100%; height:100%; object-fit:contain;
               background:#181818; pointer-events:none; }
  .icg-badge, .icg-dimensions, .icg-check { position:absolute; color:#fff;
               background:rgba(0,0,0,.72); border-radius:3px; pointer-events:none; }
  .icg-badge { top:4px; left:4px; min-width:18px; padding:1px 4px; font-size:11px;
               text-align:center; }
  .icg-dimensions { left:4px; bottom:4px; padding:1px 4px; font-size:9px; opacity:.78; }
  .icg-check { top:4px; right:4px; width:20px; height:20px; line-height:20px;
               text-align:center; font-size:14px; font-weight:bold; }
  .icg-cell.icg-selected .icg-check { background:rgba(35,145,80,.92); }
  .icg-toolbar { flex:0 0 auto; display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
  .icg-toolbar button { font-size:12px; padding:4px 10px; cursor:pointer; border-radius:3px;
                        border:1px solid #555; color:#fff; }
  .icg-toolbar button:disabled { opacity:.42; cursor:default; }
  .icg-secondary { background:rgba(45,45,45,.95); }
  .icg-pass { background:rgba(40,130,70,.95); }
  .icg-pass:hover:not(:disabled) { background:rgba(55,160,90,.98); }
  .icg-run { background:rgba(40,90,140,.95); }
  .icg-stop { background:rgba(160,40,40,.9); margin-left:auto; }
  .icg-status { font-size:11px; opacity:.72; padding:0 3px; }
  .icg-error { color:#ff8a8a; opacity:1; }
  .icg-resolved { color:#83e5aa; opacity:.95; }
  `;
  const style = document.createElement("style");
  style.id = "icg-styles";
  style.textContent = css;
  document.head.appendChild(style);
}

function setupChooserNode(node) {
  injectStyles();
  chooserNodes.add(node);

  // This node owns its preview UI; suppress ComfyUI's output-image preview.
  try {
    Object.defineProperty(node, "imgs", {
      configurable: true,
      get() { return undefined; },
      set() { /* suppress */ },
    });
  } catch (e) { /* best effort */ }

  const wrap = document.createElement("div");
  wrap.className = "icg-wrap";
  const grid = document.createElement("div");
  grid.className = "icg-grid";
  const toolbar = document.createElement("div");
  toolbar.className = "icg-toolbar";
  wrap.appendChild(grid);
  wrap.appendChild(toolbar);

  node._icg = { wrap, grid, toolbar };
  node._icgItems = [];
  node._icgCells = new Map();
  node._icgSelected = new Set();
  node._icgState = "idle";
  node._icgBusy = false;
  node._icgRevision = 0;
  node._icgWaitId = null;
  node._icgToken = null;
  node._icgQueueBusy = false;

  node._icgWidget = node.addDOMWidget("image_chooser", "div", wrap, {
    serialize: false,
    getMinHeight: () => widgetFloor(node),
  });

  const onResize = node.onResize;
  node.onResize = function () {
    const result = onResize?.apply(this, arguments);
    syncWidgetWidth(node);
    return result;
  };

  // Removing an actively waiting chooser must not strand the executor.
  const onRemoved = node.onRemoved;
  node.onRemoved = function () {
    if (node._icgState === "paused" && node._icgToken) {
      postChooser(node, { action: "cancel" }).catch(() => {});
    }
    chooserNodes.delete(node);
    return onRemoved?.apply(this, arguments);
  };

  node.setSize([Math.max(node.size?.[0] || 0, MIN_W), node.computeSize()[1]]);
  resizeChooser(node);
}

app.registerExtension({
  name: "datasete.gates.imagechooser",

  setup() {
    api.addEventListener("datasete-image-chooser-show", (event) => {
      const data = event.detail || {};
      const displayId = data.display_id ?? data.id;
      const node = chooserByLocator(displayId);
      if (!node || node.type !== NODE || !node._icg) return;
      showBatch(node, data.id, data.token, data.images);
    });

    // Collapse the previous review as a new execution starts; a fresh chooser
    // event will reopen it if this run reaches the node. An interrupt leaves an
    // honest stopped state.
    api.addEventListener("execution_start", () => {
      for (const node of chooserNodes) {
        if (node.type !== NODE || node._icgState === "idle") continue;
        node._icgRevision += 1;
        node._icgState = "idle";
        node._icgBusy = false;
        node._icgQueueBusy = false;
        node._icgWaitId = null;
        node._icgToken = null;
        resizeChooser(node);
      }
    });
    api.addEventListener("execution_interrupted", () => {
      for (const node of chooserNodes) {
        if (node.type !== NODE
            || (node._icgState !== "paused" && !node._icgQueueBusy)) continue;
        node._icgRevision += 1;
        node._icgState = "resolved";
        node._icgBusy = false;
        node._icgQueueBusy = false;
        node._icgStopped = true;
        node._icgWaitId = null;
        node._icgToken = null;
        renderGridState(node);
        renderToolbar(node);
      }
    });
    api.addEventListener("execution_error", () => {
      for (const node of chooserNodes) {
        if (node.type !== NODE
            || (node._icgState !== "paused" && !node._icgQueueBusy)) continue;
        node._icgRevision += 1;
        node._icgState = "resolved";
        node._icgBusy = false;
        node._icgQueueBusy = false;
        node._icgStopped = true;
        node._icgError = "Execution stopped with an error";
        node._icgWaitId = null;
        node._icgToken = null;
        renderGridState(node);
        renderToolbar(node);
      }
    });
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = onNodeCreated?.apply(this, arguments);
      setupChooserNode(this);
      return result;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const result = onConfigure?.apply(this, arguments);
      if (this._icg) syncWidgetWidth(this);
      return result;
    };
  },
});
