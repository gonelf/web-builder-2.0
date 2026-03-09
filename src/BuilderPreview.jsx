import React, { useState, useEffect, useRef } from 'react';
import { WebContainer } from '@webcontainer/api';
import { GoogleGenerativeAI } from '@google/generative-ai';
import registry from './registry.json';
import toonMenuRaw from './menu.toon?raw';

// ---------------------------------------------------------------------------
// Gemini setup
// ---------------------------------------------------------------------------
const genAI = new GoogleGenerativeAI(import.meta.env.VITE_GEMINI_API_KEY || '');
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

// System instruction sent to Gemini — read the TOON menu at runtime
const buildSystemInstruction = () => `
You are a UI-ARCHITECT. Your ONLY output is a single TOON blueprint line.

CONSTRAINTS
- Respond ONLY in TOON format. Never write HTML, CSS, or JavaScript.
- Your response must match EXACTLY this schema: blueprint[N]: id1, id2, id3
- Use ONLY component IDs that appear in the menu below.
- Choose 3–6 components that make sense together as a full page.
- Always start with a navigation component and end with a footer component.

COMPONENT MENU (TOON Format)
${toonMenuRaw}

EXAMPLE OUTPUT
blueprint[5]: nav-1, hero-split, stats-3col, pricing-tiers, footer-social
`;

// ---------------------------------------------------------------------------
// TOON parser
// ---------------------------------------------------------------------------
function parseToonBlueprint(toonStr) {
  try {
    // Handles: "blueprint[5]: nav-1, hero-split, footer-social"
    const colonIdx = toonStr.indexOf(':');
    if (colonIdx === -1) throw new Error('No colon found');
    const body = toonStr.slice(colonIdx + 1);
    return body
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (e) {
    console.error('[TOON] Failed to parse:', toonStr, e);
    return [];
  }
}

// ---------------------------------------------------------------------------
// HTML stitcher — builds a full standalone document from component IDs
// ---------------------------------------------------------------------------
function stitchHtml(ids, inlineTailwind) {
  const sections = ids
    .map((id) => {
      if (!registry[id]) {
        console.warn(`[Stitcher] Unknown component ID: "${id}" — skipping`);
        return `<!-- component "${id}" not found in registry -->`;
      }
      return `\n<!-- ▸ ${id} -->\n${registry[id].html}`;
    })
    .join('\n');

  // Inline the pre-fetched Tailwind script to avoid COEP/CORP blocking.
  // The WebContainer iframe inherits require-corp from the parent page,
  // so external CDN requests are blocked unless they send CORP headers.
  const tailwindTag = inlineTailwind
    ? `<script>${inlineTailwind}</script>`
    : `<script src="https://cdn.tailwindcss.com"></script>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  ${tailwindTag}
  <style>
    /* HyperUI uses font-sans; map to system stack */
    body { font-family: ui-sans-serif, system-ui, sans-serif; }
  </style>
</head>
<body class="bg-white">
${sections}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// WebContainer file system setup
// Uses a zero-dependency Node.js HTTP server to avoid npm install
// ---------------------------------------------------------------------------
const WC_FILES = {
  'server.mjs': {
    file: {
      contents: `
import http from 'http';
import fs from 'fs';

const server = http.createServer((_req, res) => {
  const html = fs.readFileSync('index.html', 'utf8');
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
});

server.listen(3000, () => console.log('Server ready on port 3000'));
`.trim(),
    },
  },
  'index.html': {
    file: {
      contents: `<!DOCTYPE html><html><head><script src="https://cdn.tailwindcss.com"></script></head><body class="flex h-screen items-center justify-center bg-gray-50"><p class="text-gray-400 text-lg">Enter a prompt to build your page...</p></body></html>`,
    },
  },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function BuilderPreview() {
  const [prompt, setPrompt] = useState('');
  const [iframeUrl, setIframeUrl] = useState('');
  const [isBooting, setIsBooting] = useState(true);
  const [isBuilding, setIsBuilding] = useState(false);
  const [status, setStatus] = useState('Booting WebContainer...');
  const [blueprint, setBlueprint] = useState(null); // { toon, ids }
  const [error, setError] = useState('');
  const [iframeKey, setIframeKey] = useState(0);
  const wcRef = useRef(null);
  const tailwindRef = useRef(''); // cached CDN script for inline injection

  // ── Boot the WebContainer on mount ──────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    // Pre-fetch Tailwind CDN from parent context (no COEP restriction here)
    // so we can inline it into the iframe HTML and avoid cross-origin blocking.
    fetch('https://cdn.tailwindcss.com')
      .then((r) => r.text())
      .then((text) => { tailwindRef.current = text; })
      .catch((e) => console.warn('[Tailwind prefetch]', e));

    async function boot() {
      try {
        if (wcRef.current) return; // StrictMode double-invoke guard

        setStatus('Booting WebContainer engine...');
        const wc = await WebContainer.boot();
        wcRef.current = wc;

        setStatus('Mounting file system...');
        await wc.mount(WC_FILES);

        setStatus('Starting preview server...');
        const server = await wc.spawn('node', ['server.mjs']);
        server.output.pipeTo(
          new WritableStream({ write: (chunk) => console.log('[server]', chunk) })
        );

        wc.on('server-ready', (_port, url) => {
          if (!cancelled) {
            setIframeUrl(url);
            setIsBooting(false);
            setStatus('Ready');
          }
        });
      } catch (err) {
        if (!cancelled) {
          console.error('[Boot]', err);
          setStatus(`Boot failed: ${err.message}`);
          setIsBooting(false);
        }
      }
    }

    boot();
    return () => { cancelled = true; };
  }, []);

  // ── Handle build request ─────────────────────────────────────────────────
  const handleBuild = async (e) => {
    e.preventDefault();
    if (!prompt.trim() || !wcRef.current || isBuilding) return;

    setIsBuilding(true);
    setError('');
    setBlueprint(null);
    setStatus('Asking Gemini for a layout blueprint...');

    try {
      // 1. Ask Gemini (TOON only — no HTML generated)
      const systemInstruction = buildSystemInstruction();
      const result = await model.generateContent(
        `${systemInstruction}\n\nUser request: ${prompt}`
      );
      const toonResponse = result.response.text().trim();
      console.log('[Gemini TOON]', toonResponse);

      // 2. Parse the blueprint
      setStatus('Parsing TOON blueprint...');
      const ids = parseToonBlueprint(toonResponse);
      if (ids.length === 0) throw new Error(`Could not parse TOON response: "${toonResponse}"`);

      setBlueprint({ toon: toonResponse, ids });

      // 3. Stitch HTML locally (zero LLM tokens spent here)
      setStatus('Stitching components...');
      const finalHtml = stitchHtml(ids, tailwindRef.current);

      // 4. Hot-write to WebContainer then remount the iframe to fetch new content
      await wcRef.current.fs.writeFile('/index.html', finalHtml);
      setIframeKey((k) => k + 1);
      setStatus(`Built with ${ids.length} components`);
    } catch (err) {
      console.error('[Build]', err);
      const msg = err.message || String(err);
      setError(msg);
      setStatus('Build failed');
    } finally {
      setIsBuilding(false);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#f8fafc', fontFamily: 'system-ui, sans-serif' }}>

      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <div style={{ background: '#1e293b', color: '#f1f5f9', padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.3)' }}>
        <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.5px', flexShrink: 0 }}>
          🏗️ Web Builder <span style={{ color: '#38bdf8' }}>2.0</span>
        </span>
        <span style={{ color: '#64748b', fontSize: 12, flexShrink: 0 }}>TOON + Gemini 2.5 Flash + WebContainer</span>
      </div>

      {/* ── Control panel ──────────────────────────────────────────────── */}
      <form
        onSubmit={handleBuild}
        style={{ background: '#fff', borderBottom: '1px solid #e2e8f0', padding: '12px 20px', display: 'flex', gap: 10, alignItems: 'center' }}
      >
        <input
          type="text"
          placeholder="Describe your page… e.g. 'A dark SaaS landing page for a productivity app'"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={isBooting || isBuilding}
          style={{
            flex: 1,
            padding: '10px 14px',
            border: '1px solid #cbd5e1',
            borderRadius: 8,
            fontSize: 14,
            outline: 'none',
            background: isBooting ? '#f1f5f9' : '#fff',
            color: '#1e293b',
          }}
        />
        <button
          type="submit"
          disabled={isBooting || isBuilding || !prompt.trim()}
          style={{
            background: isBooting || isBuilding || !prompt.trim() ? '#94a3b8' : '#0ea5e9',
            color: '#fff',
            border: 'none',
            borderRadius: 8,
            padding: '10px 20px',
            fontSize: 14,
            fontWeight: 600,
            cursor: isBooting || isBuilding || !prompt.trim() ? 'not-allowed' : 'pointer',
            flexShrink: 0,
            transition: 'background 0.15s',
          }}
        >
          {isBuilding ? 'Architecting...' : 'Build Page'}
        </button>
      </form>

      {/* ── Status + blueprint strip ────────────────────────────────────── */}
      <div style={{ background: '#0f172a', color: '#94a3b8', fontSize: 12, padding: '6px 20px', display: 'flex', alignItems: 'center', gap: 12, minHeight: 32, flexWrap: 'wrap' }}>
        <span style={{ color: isBooting ? '#fbbf24' : error ? '#f87171' : '#4ade80' }}>●</span>
        <span>{status}</span>
        {blueprint && (
          <>
            <span style={{ color: '#475569' }}>│</span>
            <span style={{ color: '#7dd3fc', fontFamily: 'monospace' }}>{blueprint.toon}</span>
          </>
        )}
        {error && (
          <>
            <span style={{ color: '#475569' }}>│</span>
            <span style={{ color: '#fca5a5' }}>{error}</span>
          </>
        )}
      </div>

      {/* ── Preview iframe ──────────────────────────────────────────────── */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {isBooting && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', background: '#f8fafc', gap: 16,
          }}>
            <div style={{ width: 40, height: 40, border: '3px solid #e2e8f0', borderTop: '3px solid #0ea5e9', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            <p style={{ color: '#64748b', fontSize: 14 }}>{status}</p>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}
        {iframeUrl && (
          <iframe
            key={iframeKey}
            src={iframeUrl}
            title="Live Preview"
            style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
          />
        )}
      </div>

      {/* ── Component registry panel (collapsible) ─────────────────────── */}
      <RegistryPanel />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small bottom panel showing available components
// ---------------------------------------------------------------------------
function RegistryPanel() {
  const [open, setOpen] = useState(false);
  const ids = Object.keys(registry);

  return (
    <div style={{ background: '#1e293b', borderTop: '1px solid #334155', color: '#94a3b8', fontSize: 12 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', padding: '6px 20px', width: '100%', textAlign: 'left', display: 'flex', gap: 8 }}
      >
        <span>{open ? '▼' : '▲'}</span>
        <span>Component Registry ({ids.length} components)</span>
      </button>
      {open && (
        <div style={{ padding: '8px 20px 12px', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {ids.map((id) => (
            <span
              key={id}
              title={registry[id].description}
              style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 4, padding: '2px 8px', fontFamily: 'monospace', color: '#7dd3fc', fontSize: 11 }}
            >
              {id}
              <span style={{ color: '#475569', marginLeft: 4 }}>({registry[id].category})</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
