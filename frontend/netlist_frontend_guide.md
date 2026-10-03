# netlist.json — Frontend Integration Guide

This document explains how to load `netlist.json` in a **Vite + React** app
and render the full circuit: component symbols + wires + net colors.

---

## 1. JSON Schema Reference

```json
{
  "title": "mycircuit1",
  "timestamp": "2026-08-20 17:35:45",

  "image": {
    "width": 1884,      // original photo width in pixels
    "height": 4080      // original photo height in pixels
  },

  "wires": {
    "segments": [
      { "x1": 1243, "y1": 2306, "x2": 1665, "y2": 2322 }
      // ... more wire lines
    ],
    "junctions": [
      { "x": 354, "y": 1561 }   // T/cross junction dot
      // ...
    ],
    "endpoints": [
      { "x": 1199, "y": 1518 }  // loose wire end (usually near a pin)
      // ...
    ]
  },

  "nets": [
    { "id": "VCC",  "pins": ["V1.+"] },
    { "id": "N001", "pins": ["V1.-", "R1.A"] }
    // ...
  ],

  "components": [
    {
      "ref_des": "R1",
      "type": "Resistor",
      "value": "1k",
      "net_pos": "N004",
      "net_neg": "N005",
      "spice_line": "R1 N004 N005 1k"
    }
    // ...
  ],

  "component_details": [
    {
      "ref_des": "R1",
      "type": "Resistor",
      "conf": 0.747,             // detection confidence (0–1)
      "bbox": {
        "x1": 593, "y1": 1383,  // top-left corner (original image coords)
        "x2": 1157, "y2": 1685, // bottom-right corner
        "cx": 875, "cy": 1534   // center point
      },
      "pins": [
        { "name": "A", "x": 621, "y": 1534, "net_id": "N004" },
        { "name": "B", "x": 1129, "y": 1534, "net_id": "N005" }
      ]
    }
    // ...
  ]
}
```

> **Key point:** All `x`, `y`, `x1`, `y1`, `x2`, `y2` values are in the
> **original photo's pixel coordinate system** (e.g. 1884 × 4080 px).
> You MUST scale them down to fit your canvas.

---

## 2. Coordinate Scaling

```js
// Utility: compute scale factor to fit image into canvas
function computeScale(imageW, imageH, canvasW, canvasH) {
  return Math.min(canvasW / imageW, canvasH / imageH);
}

// Scale a single point
function scalePoint(x, y, scale) {
  return { x: x * scale, y: y * scale };
}
```

---

## 3. Net Color System

Assign a consistent color to each net so wires and pins sharing
the same net are the same color:

```js
const NET_PALETTE = [
  '#ff5252', // N001
  '#00e5ff', // N002
  '#b44cff', // N003
  '#69f0ae', // N004
  '#ffd740', // N005
  '#ff80ab', // N006
  '#40c4ff', // N007
];

// Special nets
const NET_SPECIAL = {
  GND: '#6b8cff',
  VCC: '#00e676',
  VDD: '#00e676',
};

function getNetColor(netId, netList) {
  if (NET_SPECIAL[netId]) return NET_SPECIAL[netId];
  const idx = netList.findIndex(n => n.id === netId);
  return NET_PALETTE[idx % NET_PALETTE.length];
}
```

---

## 4. Component Symbol Emoji/Icon Map

Since we are drawing bounding boxes (not full KiCad-style SVG symbols),
use a label + icon approach:

```js
const COMPONENT_ICONS = {
  'Resistor'    : '⊟',   // or use an SVG path
  'Capacitor'   : '⊣⊢',
  'Inductor'    : '⌇',
  'Diode'       : '⊳|',
  'Battery'     : '⊕',
  'Voltage'     : 'V~',
  'AC Source'   : '~',
  'Ground'      : '⏚',
  'Dep. Voltage': '◇',
};

const COMPONENT_COLORS = {
  'Resistor'    : '#ff9800',
  'Capacitor'   : '#00bcd4',
  'Inductor'    : '#9c27b0',
  'Diode'       : '#e91e63',
  'Battery'     : '#4caf50',
  'Voltage'     : '#4caf50',
  'AC Source'   : '#3f51b5',
  'Ground'      : '#607d8b',
  'Dep. Voltage': '#ff5722',
};
```

---

## 5. Full React Component

Create `src/components/CircuitCanvas.jsx`:

```jsx
import { useEffect, useRef } from 'react';

// ── Config ────────────────────────────────────────────────

const NET_PALETTE = [
  '#ff5252','#00e5ff','#b44cff','#69f0ae',
  '#ffd740','#ff80ab','#40c4ff','#ffab40',
];
const NET_SPECIAL = { GND: '#6b8cff', VCC: '#00e676', VDD: '#00e676' };

const COMPONENT_COLORS = {
  Resistor: '#ff9800', Capacitor: '#00bcd4', Inductor: '#9c27b0',
  Diode: '#e91e63', Battery: '#4caf50', Voltage: '#4caf50',
  'AC Source': '#3f51b5', Ground: '#607d8b', 'Dep. Voltage': '#ff5722',
};

// ── Helpers ───────────────────────────────────────────────

function getNetColor(netId, nets) {
  if (NET_SPECIAL[netId]) return NET_SPECIAL[netId];
  const idx = nets.findIndex(n => n.id === netId);
  return idx >= 0 ? NET_PALETTE[idx % NET_PALETTE.length] : '#aaaaaa';
}

// ── Main Component ────────────────────────────────────────

export default function CircuitCanvas({ netlist }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!netlist || !canvasRef.current) return;
    drawCircuit(canvasRef.current, netlist);
  }, [netlist]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: '100%',
        height: '100%',
        background: '#1a1a2e',
        borderRadius: '12px',
      }}
    />
  );
}

// ── Draw Everything ───────────────────────────────────────

function drawCircuit(canvas, netlist) {
  const ctx = canvas.getContext('2d');

  // 1. Compute scale to fit original image into canvas
  const { width: imgW, height: imgH } = netlist.image;
  const canvasW = canvas.offsetWidth  || 800;
  const canvasH = canvas.offsetHeight || 600;

  canvas.width  = canvasW;
  canvas.height = canvasH;

  const scale = Math.min(canvasW / imgW, canvasH / imgH) * 0.95;
  const offsetX = (canvasW - imgW * scale) / 2;
  const offsetY = (canvasH - imgH * scale) / 2;

  // Helper: convert original coords to canvas coords
  const sx = (x) => x * scale + offsetX;
  const sy = (y) => y * scale + offsetY;

  // 2. Clear
  ctx.clearRect(0, 0, canvasW, canvasH);

  // 3. Draw wire segments
  const { segments, junctions, endpoints } = netlist.wires;

  ctx.strokeStyle = '#00e5ff';
  ctx.lineWidth   = Math.max(1.5, scale * 2);
  ctx.lineCap     = 'round';

  segments.forEach(seg => {
    ctx.beginPath();
    ctx.moveTo(sx(seg.x1), sy(seg.y1));
    ctx.lineTo(sx(seg.x2), sy(seg.y2));
    ctx.stroke();
  });

  // 4. Draw junction dots (T/cross points)
  const junctionR = Math.max(3, scale * 4);
  junctions.forEach(pt => {
    ctx.beginPath();
    ctx.arc(sx(pt.x), sy(pt.y), junctionR, 0, Math.PI * 2);
    ctx.fillStyle = '#00ff9d';
    ctx.fill();
  });

  // 5. Draw component bounding boxes + labels + pins
  netlist.component_details.forEach(comp => {
    const { bbox, type, ref_des, pins } = comp;
    const compColor = COMPONENT_COLORS[type] || '#ffffff';

    const bx1 = sx(bbox.x1), by1 = sy(bbox.y1);
    const bx2 = sx(bbox.x2), by2 = sy(bbox.y2);
    const bw  = bx2 - bx1;
    const bh  = by2 - by1;

    // Box background (subtle)
    ctx.fillStyle   = compColor + '22'; // 13% opacity
    ctx.strokeStyle = compColor;
    ctx.lineWidth   = Math.max(1.5, scale * 2);
    ctx.beginPath();
    ctx.roundRect(bx1, by1, bw, bh, 4);
    ctx.fill();
    ctx.stroke();

    // Label: ref_des (e.g. "R1") + type
    const fontSize = Math.max(10, Math.min(16, scale * 14));
    ctx.font      = `bold ${fontSize}px Inter, sans-serif`;
    ctx.fillStyle = compColor;
    ctx.fillText(`${ref_des}`, bx1 + 4, by1 - 4);

    const smallFont = Math.max(8, fontSize - 3);
    ctx.font      = `${smallFont}px Inter, sans-serif`;
    ctx.fillStyle = '#cccccc';

    // Find value from components array
    const compMeta = netlist.components.find(c => c.ref_des === ref_des);
    if (compMeta?.value) {
      ctx.fillText(compMeta.value, bx1 + 4, by2 + smallFont + 2);
    }

    // 6. Draw pins with net colors
    const pinR = Math.max(3, scale * 5);
    pins.forEach(pin => {
      const pinColor = getNetColor(pin.net_id, netlist.nets);
      const px = sx(pin.x);
      const py = sy(pin.y);

      ctx.beginPath();
      ctx.arc(px, py, pinR, 0, Math.PI * 2);
      ctx.fillStyle   = pinColor;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth   = 1;
      ctx.fill();
      ctx.stroke();

      // Net label near pin
      ctx.font      = `${Math.max(8, fontSize - 4)}px Inter, sans-serif`;
      ctx.fillStyle = pinColor;
      ctx.fillText(pin.net_id, px + pinR + 2, py + 4);
    });
  });

  // 7. Legend: net colors
  drawNetLegend(ctx, netlist.nets, 10, 10);
}

// ── Net Legend ────────────────────────────────────────────

function drawNetLegend(ctx, nets, x, y) {
  const lineH = 18;
  const fontSize = 11;
  ctx.font = `${fontSize}px Inter, sans-serif`;

  nets.forEach((net, i) => {
    const color = NET_SPECIAL[net.id] || NET_PALETTE[i % NET_PALETTE.length];
    const yPos  = y + i * lineH;

    ctx.fillStyle = color;
    ctx.fillRect(x, yPos, 12, 12);

    ctx.fillStyle = '#eeeeee';
    ctx.fillText(net.id, x + 16, yPos + 10);
  });
}
```

---

## 6. How to Use in Your Page

```jsx
// src/pages/NetlistViewer.jsx
import { useState } from 'react';
import CircuitCanvas from '../components/CircuitCanvas';

export default function NetlistViewer() {
  const [netlist, setNetlist] = useState(null);

  const handleLoad = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const data = JSON.parse(ev.target.result);
      setNetlist(data);
    };
    reader.readAsText(file);
  };

  return (
    <div style={{ padding: '24px' }}>
      <h2>Circuit Viewer</h2>

      {/* Load Netlist Button */}
      <label style={{ cursor: 'pointer', padding: '8px 16px',
                      background: '#6200ea', color: '#fff',
                      borderRadius: '8px' }}>
        Load Netlist (netlist.json)
        <input
          type="file"
          accept=".json"
          onChange={handleLoad}
          style={{ display: 'none' }}
        />
      </label>

      {/* Info bar */}
      {netlist && (
        <div style={{ marginTop: '12px', color: '#aaa' }}>
          <strong>{netlist.title}</strong> &nbsp;|&nbsp;
          {netlist.component_details.length} components &nbsp;|&nbsp;
          {netlist.wires.segments.length} wire segments &nbsp;|&nbsp;
          {netlist.nets.length} nets
        </div>
      )}

      {/* Canvas */}
      <div style={{ marginTop: '16px', width: '100%', height: '600px' }}>
        {netlist
          ? <CircuitCanvas netlist={netlist} />
          : <p style={{ color: '#666' }}>Load a netlist.json to view circuit</p>
        }
      </div>
    </div>
  );
}
```

---

## 7. What Gets Rendered

| Layer | What | Color |
|-------|------|-------|
| 1 | Wire segments | Cyan `#00e5ff` |
| 2 | Junction dots | Green `#00ff9d` |
| 3 | Component boxes | Per-type color, semi-transparent |
| 4 | Component labels (R1, C1...) | Per-type color |
| 5 | Component values (1k, 10u...) | Light gray |
| 6 | Pin dots | Net color |
| 7 | Net ID labels near pins | Net color |
| 8 | Legend (top-left) | Net colors |

---

## 8. Rendering Order (Z-order)

```
Wires (bottom)
  └── Junctions
        └── Component fill (semi-transparent)
              └── Component border
                    └── Pin dots
                          └── Labels (top)
```

---

## 9. Tips for the Frontend Repo

- **Responsive canvas**: call `drawCircuit()` again on window resize
  ```js
  useEffect(() => {
    window.addEventListener('resize', () => drawCircuit(canvas, netlist));
    return () => window.removeEventListener('resize', ...);
  }, [netlist]);
  ```

- **Zoom/pan**: wrap the canvas in a `transform: scale()` div + mouse wheel listener

- **Click to highlight net**: on canvas click, find nearest pin, highlight all
  wires/pins sharing that `net_id`

- **Tooltip on hover**: detect which `component_details` bbox contains the mouse
  position and show `ref_des`, `type`, `value`, `spice_line`
