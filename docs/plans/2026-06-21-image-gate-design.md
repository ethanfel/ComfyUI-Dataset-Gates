# Image Gate (Manual Router) — Design

Date: 2026-06-21
Status: Approved (brainstorming complete, ready for implementation plan)

## 1. Purpose

An interactive "image chooser on steroids": during a prompt run the node **pauses**,
shows the incoming image with a row of labeled **route buttons**, and waits for a human
click. Clicking **route K** sends the image down output K (all other route branches are
silently skipped). A **Stop** button cancels the whole run. Optionally, an **Edit mask**
button opens ComfyUI's MaskEditor on the image and the painted mask is emitted on a
single `mask` output. Built for manual dataset sorting/gating in the "Dataset Gates" suite.

Third node in the `ComfyUI-Datasete-Gates` package.

## 2. IO

| dir | name | type | notes |
|---|---|---|---|
| in | `image` | IMAGE | the image (or batch, routed as one unit) |
| widget | `routes` | INT, default 2, 1..10 | number of visible route buttons/outputs |
| widget | per-route labels | (frontend) | editable, default `1..N`; rename the visible output slots |
| hidden | `unique_id` | UNIQUE_ID | node id, used to key the pause/choice |
| out | `mask` | MASK | **fixed slot 0**; painted at the gate, zeros (sized to image) if none |
| out | `route_1 … route_10` | IMAGE | dynamic; JS shows only `routes` of them, labeled |

`RETURN_TYPES = ("MASK",) + ("IMAGE",)*10`. The node always returns all 11 outputs; the
chosen route carries the image, every other route returns `ExecutionBlocker(None)`. JS
hides the unused slots (>`routes`); their `ExecutionBlocker` returns are harmless.

## 3. Behavior (the pause)

On execute:
1. Push the image to the UI (`PromptServer.send_sync`, base64 or temp file) so the node
   body shows the preview + the N labeled route buttons + **🖌 Edit mask** + **■ Stop**.
2. **Block** the executor thread on our own `GateBus.wait(unique_id)` (a `MessageHolder`-
   style singleton in a `sleep(0.1)` loop; separate namespace from cg-image-picker).
3. Resolve:
   - **route K** → image to output `K`, `ExecutionBlocker(None)` to the other routes;
     `mask` = the painted mask (or zeros).
   - **🖌 Edit mask** → opens MaskEditor (reuse the pool node's clipspace flow); the mask
     is POSTed to `/datasete_gate/mask` keyed by `unique_id` and picked up on resume.
   - **■ Stop** → cancel the prompt cleanly via
     `comfy.model_management.InterruptProcessingException` (confirm exact symbol in plan).

`IS_CHANGED` returns `nan` → the gate pauses on **every** run (never cached).

## 4. Why the global mask is safe

Verified in `execution.py:257-266` + `305-306`: if **any** input of a node is an
`ExecutionBlocker`, the node is skipped and the blocker propagates to all its outputs.
So a non-chosen route's downstream (which consumes the blocked routed image) never runs,
regardless of the live `mask` value. Caveat: a node wired to `mask` *only* (no routed
image) would run unconditionally — not the intended wiring.

## 5. Code shape (same package)

- `gates/gate.py` — `ImageGate` node: `INPUT_TYPES`, `IS_CHANGED=nan`, `run()` (push
  preview → block → route via `ExecutionBlocker`). Pure helper `route_tuple(chosen, image,
  blocker, max_routes)` for unit testing.
- `gates/gate_server.py` — `GateBus` (start/put/wait/cancel) + mask stash; aiohttp routes
  `/datasete_gate/choice` and `/datasete_gate/mask`; `send_preview()` helper.
- `web/image_gate.js` — dynamic labeled outputs (show `routes` of 10), preview render,
  route/stop/mask buttons, posts the choice; reuses the pool's MaskEditor helper.

## 6. Edge cases

- `routes` changed between runs → JS re-syncs visible slots; Python clamps `chosen` to
  `routes`.
- Stop while no mask painted → clean interrupt, no output.
- Multiple gates in one graph → execute sequentially (single executor thread), so only one
  blocks at a time; still keyed by `unique_id`.
- Batch input → previewed as the first image / small grid; routed as one unit.
- External queue-cancel → `GateBus` honors the cancel flag and raises.

## 7. Testing

- pytest: `route_tuple` (image at chosen, blocker elsewhere, correct length); `GateBus`
  (pre-seeded message returns; cancel raises; `start` resets); mask zero-fallback sizing.
- Manual (live): pause appears, buttons labeled, click routes image to the right branch
  and only that branch runs; Edit mask round-trips and feeds `mask`; Stop cancels cleanly;
  changing `routes` adds/removes slots.
