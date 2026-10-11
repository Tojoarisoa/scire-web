// The learner's knowledge map. The page (tutor.html) loads the built file and calls
//   const map = TutorMap.mount(element, graph, { theme, onSelect });  map.update(graph);  map.destroy();
// `graph` is what GET /tutor/me/map returns: nodes (root, track, unit, topic) with mastery 0-100, level, due,
// done, next, gain; and edges (path = the study path, contains = a step and its topics).
// Read-only: nothing here changes data. Selecting a node tells the page, which shows what can be done with it.
import React, { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Background, Controls, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider } from "@xyflow/react";
import reactFlowCss from "@xyflow/react/dist/style.css";

// React Flow guidance followed here (reactflow.dev/learn/advanced-use/performance): nodeTypes and every prop object are
// created once outside the component, custom nodes are memoized, node data stays small (the theme travels by context,
// not inside every node), selecting a node does not redo the layout, and a read-only map turns off what it does not use.
const ThemeContext = createContext(null);
const useTheme = () => useContext(ThemeContext);

const LEVEL_LABEL = { new: "New", learning: "Learning", reviewing: "Reviewing", mastered: "Mastered" };
const STYLE_ID = "tutor-map-css";

function ensureCss() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = reactFlowCss + `
    .tm-node { font-family: inherit; line-height: 1.25; cursor: pointer; transition: box-shadow .15s ease, border-color .15s ease; }
    .tm-node:focus-visible, .react-flow__node:focus-visible .tm-node { outline: 2px solid var(--tm-accent, #22d3ee); outline-offset: 2px; }
    .tm-pulse { animation: tm-pulse 1.6s ease-in-out infinite; }
    @keyframes tm-pulse { 50% { transform: scale(1.5); opacity: .55; } }
    @media (prefers-reduced-motion: reduce) { .tm-pulse { animation: none; } }
    .react-flow__attribution { display: none; }
    /* Animated edges: React Flow dashes them (stroke-dasharray); the dashes are moved by one timer in mount() (it sets
       stroke-dashoffset on the flowing paths only), about eight steps a second, instead of a CSS animation on every edge, which would be re-evaluated on
       every frame. Nothing moves under reduced motion (the timer is not started). */
    .react-flow__edge.animated path { animation: none; }
  `;
  document.head.appendChild(el);
}

const colorOf = (level, t) => ({ new: t.muted, learning: t.warn, reviewing: t.accent, mastered: t.good }[level] || t.muted);

const Meter = memo(function Meter({ value, color, t }) {
  return (
    <div style={{ height: 5, borderRadius: 4, background: t.border, overflow: "hidden", marginTop: 6 }} aria-hidden="true">
      <div style={{ width: `${Math.max(0, Math.min(100, value || 0))}%`, height: "100%", background: color, transition: "width .4s ease" }} />
    </div>
  );
});

const DueDot = memo(function DueDot({ t }) {
  return <span className="tm-pulse" title="A review is due" style={{ width: 8, height: 8, borderRadius: "50%", background: t.accent2, boxShadow: `0 0 8px ${t.accent2}`, flex: "none", display: "inline-block" }} />;
});

const hidden = { opacity: 0, width: 1, height: 1, minWidth: 0, minHeight: 0, border: "none" };
const Handles = memo(function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Left} id="l" style={hidden} />
      <Handle type="source" position={Position.Right} id="r" style={hidden} />
      <Handle type="target" position={Position.Top} id="t" style={hidden} />
      <Handle type="source" position={Position.Bottom} id="b" style={hidden} isConnectable={false} />
    </>
  );
});

const TopicNode = memo(function TopicNode({ data, selected }) {
  const t = useTheme();
  const c = colorOf(data.level, t);
  return (
    <div className="tm-node" style={{ width: 200, padding: "8px 10px", borderRadius: 8, background: t.surface, color: t.text, border: `1.5px ${data.level === "new" ? "dashed" : "solid"} ${c}`, boxShadow: selected ? `0 0 0 2px ${t.accent}, 0 0 14px ${t.glow}` : "none" }}>
      <Handles />
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: c, transform: "rotate(45deg)", flex: "none" }} aria-hidden="true" />
        <strong style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{data.label}</strong>
        {data.due && <DueDot t={t} />}
        {data.level === "mastered" && <span style={{ color: t.good, fontSize: 12 }} aria-hidden="true">&#10003;</span>}
      </div>
      <Meter value={data.mastery} color={c} t={t} />
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 5, fontSize: 10.5, color: t.muted }}>
        <span>{data.attempts ? `${data.mastery}% mastery, ${data.attempts} ${data.attempts === 1 ? "try" : "tries"}` : "Not tried yet"}</span>
        {data.gain != null && <span style={{ color: data.gain > 0 ? t.good : data.gain < 0 ? t.bad : t.muted, fontWeight: 700 }}>{data.gain > 0 ? `+${data.gain}` : data.gain}</span>}
      </div>
    </div>
  );
});

const StepNode = memo(function StepNode({ data, selected }) {
  const t = useTheme();
  const state = data.done ? "done" : data.next ? "next" : "todo";
  const c = state === "done" ? t.good : state === "next" ? t.accent : t.muted;
  return (
    <div className="tm-node" style={{ width: 250, padding: "10px 12px", borderRadius: 10, background: t.surface, color: t.text, border: `2px solid ${c}`, boxShadow: selected ? `0 0 0 2px ${t.accent}, 0 0 16px ${t.glow}` : state === "next" ? `0 0 14px ${t.glow}` : "none" }}>
      <Handles />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 22, height: 22, borderRadius: "50%", display: "grid", placeItems: "center", background: state === "done" ? t.good : "transparent", border: `2px solid ${c}`, color: state === "done" ? t.onAccent : c, fontSize: 11, fontWeight: 800, flex: "none" }} aria-hidden="true">
          {state === "done" ? "✓" : data.index}
        </span>
        <strong style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{data.label}</strong>
        {data.due && <DueDot t={t} />}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6, fontSize: 10.5, color: t.muted }}>
        {state === "next" && <span style={{ color: t.accent, fontWeight: 700 }}>Up next</span>}
        <span>{data.sub}</span>
        {data.mastery != null && <span style={{ marginLeft: "auto", fontWeight: 700, color: t.text }}>{data.mastery}%</span>}
      </div>
      {data.mastery != null && <Meter value={data.mastery} color={c} t={t} />}
    </div>
  );
});

const HubNode = memo(function HubNode({ data, selected }) {
  const t = useTheme();
  const root = data.kind === "root";
  return (
    <div className="tm-node" style={{ width: root ? 190 : 210, padding: "10px 12px", borderRadius: 10, background: root ? t.accentSoft : t.surface, color: t.text, border: `2px solid ${root ? t.accent : data.mastery != null ? t.accent : t.border}`, boxShadow: selected ? `0 0 0 2px ${t.accent}, 0 0 16px ${t.glow}` : "none" }}>
      <Handles />
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <strong style={{ fontSize: 13, textTransform: "capitalize", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{data.label}</strong>
        {data.due && <DueDot t={t} />}
      </div>
      <div style={{ display: "flex", marginTop: 4, fontSize: 10.5, color: t.muted }}>
        <span>{data.sub}</span>
        {data.mastery != null && <span style={{ marginLeft: "auto", fontWeight: 700, color: t.text }}>{data.mastery}%</span>}
      </div>
      {data.mastery != null && <Meter value={data.mastery} color={t.accent} t={t} />}
    </div>
  );
});

const nodeTypes = { topic: TopicNode, step: StepNode, hub: HubNode };

// Roadmap layout: every step of the path (a unit, or a track of the course) is one row; its topics run to the right.
const ROW_GAP = 28, TOPIC_W = 214, TOPIC_H = 76, PER_LINE = 4, HEAD_W = 290;
const MAX_FLOWING = 12;  // an animated edge is main-thread work every frame (about 1.3 ms/s each), so only this many flow at once

export function layout(graph, theme) {
  const heads = graph.nodes.filter((n) => n.kind === "unit" || n.kind === "track");
  const topicsOf = (id) => graph.nodes.filter((n) => n.kind === "topic" && n.parent === id);
  const hasRoot = graph.nodes.some((n) => n.kind === "root");
  const nodes = [];
  let y = 0;
  const headY = {};
  heads.forEach((h, i) => {
    const kids = topicsOf(h.id);
    const lines = Math.max(1, Math.ceil(kids.length / PER_LINE));
    const rowH = Math.max(92, lines * TOPIC_H + 8);
    headY[h.id] = y + rowH / 2 - 40;
    nodes.push({
      id: h.id, type: h.kind === "unit" ? "step" : "hub", position: { x: hasRoot ? 260 : 0, y: headY[h.id] },
      data: { ...h, index: i + 1 }, draggable: false,
      ariaLabel: `${h.label}${h.done ? ", done" : h.next ? ", up next" : ""}${h.mastery != null ? `, mastery ${h.mastery} percent` : ""}`,
    });
    kids.forEach((k, j) => {
      nodes.push({
        id: k.id, type: "topic", position: { x: (hasRoot ? 260 : 0) + HEAD_W + (j % PER_LINE) * TOPIC_W, y: y + Math.floor(j / PER_LINE) * TOPIC_H + (rowH - lines * TOPIC_H) / 2 + 4 },
        data: { ...k }, draggable: false,
        ariaLabel: `${k.label}, ${LEVEL_LABEL[k.level] || "New"}, mastery ${k.mastery} percent${k.due ? ", review due" : ""}`,
      });
    });
    y += rowH + ROW_GAP;
  });
  const root = graph.nodes.find((n) => n.kind === "root");
  if (root) {
    nodes.unshift({ id: root.id, type: "hub", position: { x: 0, y: Math.max(0, (y - ROW_GAP) / 2 - 40) }, data: { ...root }, draggable: false, ariaLabel: root.label });
  }
  const byId = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));
  // An edge flows (React Flow's `animated`) while it still has something to carry: the path not yet climbed, and the
  // topics in progress or due. Done and untouched edges stay still.
  const started = graph.nodes.some((n) => n.kind === "topic" || (n.mastery != null && n.mastery > 0));
  const live = (e) => {
    const target = byId[e.target];
    if (!target) return false;
    if (e.kind === "path") return !e.done;
    if (target.kind === "topic") return !!target.due || target.level === "learning" || target.level === "reviewing";
    // a track or a step: it flows while it has something in progress or due, or, before anything is started, as an
    // invitation to begin (the built-in course is a root and its tracks, with no path between steps)
    return !!target.due || (target.mastery != null && target.mastery < 100 && !target.done) || !started;
  };
  // The nearest steps of the path first (they are listed in order, done ones first), then the live topics, then more path.
  const flows = new Set();
  const take = (list, n) => { for (const e of list) { if (flows.size >= MAX_FLOWING || n <= 0) return; if (!flows.has(e.id)) { flows.add(e.id); n -= 1; } } };
  const livePath = graph.edges.filter((x) => x.kind === "path" && live(x));
  take(livePath, 6);
  take(graph.edges.filter((x) => x.kind !== "path" && live(x)), MAX_FLOWING);
  take(livePath, MAX_FLOWING);
  const edges = graph.edges.map((e) => {
    const path = e.kind === "path";
    const target = byId[e.target];
    const toTopic = target && target.kind === "topic";
    const flowing = flows.has(e.id);
    const color = path ? (e.done ? theme.good : flowing ? theme.accent : theme.border) : toTopic ? colorOf(target.level, theme) : theme.accent;
    const dim = (toTopic && target.level === "new") || (path && flowing && !(target && target.next));
    return {
      id: e.id, source: e.source, target: e.target,
      sourceHandle: path ? "b" : "r", targetHandle: path ? "t" : "l",
      type: "smoothstep", animated: flowing,
      style: { stroke: color, strokeWidth: path ? 2.5 : 1.5, opacity: toTopic && target.level === "new" ? 0.5 : dim ? 0.6 : 1, strokeDasharray: toTopic && target.level === "new" ? "4 4" : undefined },
    };
  });
  return { nodes, edges, headY, height: y };
}

const PRO_OPTIONS = { hideAttribution: true };
const ZOOM_KEYS = ["Control", "Meta"];
const BIG_MAP = 80;  // beyond this many nodes only what is on screen is drawn
const NOOP = () => {};

// React Flow's own `animated` edges run one CSS animation per edge, which the browser re-evaluates every frame (measured:
// 3 to 4 times the cost of this). The edges are still flagged `animated` (that is what dashes them); this moves the
// dashes of the flowing ones about eight times a second, and only while the map is on screen. Nothing under reduced motion.
function useFlowingDashes(ref) {
  useEffect(() => {
    let reduced = false;
    try { reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (_) {}
    if (reduced) return undefined;
    let step = 0;
    const timer = setInterval(() => {
      const el = ref.current;
      if (!el || document.hidden || el.getClientRects().length === 0) return;
      step = (step + 1) % 10;
      for (const path of el.querySelectorAll(".react-flow__edge.animated path")) path.style.strokeDashoffset = String(10 - step);
    }, 125);
    return () => clearInterval(timer);
  }, [ref]);
}

function MapView({ graph, theme, selectedId, onSelect, onReady }) {
  const wrapper = useRef(null);
  const flow = useRef(null);
  const [ready, setReady] = useState(false);
  useFlowingDashes(wrapper);
  // The layout depends on the data only; picking a node just flips `selected` on two nodes and keeps the rest as they were.
  const { nodes: laid, edges } = useMemo(() => layout(graph, theme), [graph, theme]);
  // A controlled flow has to carry the sizes React Flow measures back onto its nodes (that is what `onNodesChange` is for). If a node
  // object is replaced without them, React Flow forgets the node's size and connection points, keeps the node hidden and drops its
  // edges until something happens to re-measure it: picking a node (which replaces two node objects) did exactly that.
  const [sizes, setSizes] = useState({});
  const onNodesChange = useCallback((changes) => {
    const found = changes.filter((c) => c.type === "dimensions" && c.dimensions);
    if (found.length) setSizes((s) => { const next = { ...s }; for (const c of found) next[c.id] = c.dimensions; return next; });
  }, []);
  const nodes = useMemo(() => laid.map((n) => {
    const selected = n.id === selectedId, measured = sizes[n.id];
    return !!n.selected === selected && n.measured === measured ? n : { ...n, selected, measured };
  }), [laid, selectedId, sizes]);
  useEffect(() => {
    if (!ready || !flow.current) return;
    // Start on the step that is up next (or the whole map when it is small), not on a tiny view of everything.
    const next = graph.nodes.find((n) => n.next) || graph.nodes.find((n) => n.kind === "topic" && n.due);
    const target = next ? laid.find((n) => n.id === next.id) : null;
    if (laid.length > 28 && target) flow.current.setCenter(target.position.x + 420, target.position.y + 40, { zoom: 0.8, duration: 0 });
    else flow.current.fitView({ padding: 0.12, maxZoom: 1, duration: 0 });
    if (onReady) onReady();
  }, [ready, graph]);
  const onError = useCallback((code, message) => { if (typeof console !== "undefined") console.warn("[knowledge map]", code, message); }, []);
  const onInit = useCallback((instance) => { flow.current = instance; setReady(true); }, []);
  const onNodeClick = useCallback((_, node) => onSelect(graph.nodes.find((n) => n.id === node.id) || null), [graph, onSelect]);
  const onPaneClick = useCallback(() => onSelect(null), [onSelect]);
  const miniMapColor = useCallback((n) => (n.type === "topic" ? colorOf(n.data.level, theme) : n.data.done ? theme.good : theme.accent), [theme]);
  const miniMapStyle = useMemo(() => ({ background: theme.surface, border: `1px solid ${theme.border}` }), [theme]);
  return (
    <ReactFlow
      ref={wrapper}
      nodes={nodes} edges={edges} nodeTypes={nodeTypes} colorMode={theme.mode}
      onInit={onInit} onNodeClick={onNodeClick} onPaneClick={onPaneClick} onNodesChange={onNodesChange} onError={onError}
      nodesDraggable={false} nodesConnectable={false} edgesFocusable={false} elementsSelectable deleteKeyCode={null}
      onlyRenderVisibleElements={nodes.length > BIG_MAP}
      zoomOnScroll={false} panOnScroll={false} zoomActivationKeyCode={ZOOM_KEYS} preventScrolling={false}
      minZoom={0.25} maxZoom={1.6} proOptions={PRO_OPTIONS}
      aria-label="Knowledge map"
    >
      <Background gap={22} size={1} color={theme.border} />
      <Controls showInteractive={false} position="bottom-left" />
      {nodes.length > 12 && <MiniMap pannable zoomable position="bottom-right" nodeColor={miniMapColor} maskColor="rgba(0,0,0,0.35)" style={miniMapStyle} />}
    </ReactFlow>
  );
}

function App({ graph, theme, onSelect, onReady }) {
  const [selected, setSelected] = useState(null);
  const choose = useCallback((node) => { setSelected(node ? node.id : null); onSelect(node); }, [onSelect]);
  return (
    <ThemeContext.Provider value={theme}>
      <ReactFlowProvider>
        <MapView graph={graph} theme={theme} selectedId={selected} onSelect={choose} onReady={onReady} />
      </ReactFlowProvider>
    </ThemeContext.Provider>
  );
}

export function mount(el, graph, options = {}) {
  ensureCss();
  const theme = options.theme;
  el.style.setProperty("--tm-accent", theme.accent);
  const root = createRoot(el);
  const onSelect = options.onSelect || NOOP;
  const draw = (g) => root.render(<App graph={g} theme={theme} onSelect={onSelect} onReady={options.onReady} />);
  draw(graph);
  return { update: draw, destroy: () => root.unmount() };
}
