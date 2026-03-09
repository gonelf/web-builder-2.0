#!/usr/bin/env python3
"""
Tailblocks JSX → HTML converter and registry injector.
Fetches components from mertJF/tailblocks on GitHub (light theme, default indigo),
converts JSX to static HTML, then merges them into registry.json and menu.toon.

Usage:
  python3 scripts/convert_tailblocks.py
"""

import json
import re
import sys
import urllib.request
from pathlib import Path

TAILBLOCKS_RAW = "https://raw.githubusercontent.com/mertJF/tailblocks/master/src/blocks"

# id -> (path_in_repo, category, description)
TAILBLOCKS_MANIFEST = {
    "tb-header-a":      ("header/light/a.js",      "layout",      "Tailblocks navbar with logo, nav links, and CTA button"),
    "tb-hero-a":        ("hero/light/a.js",         "marketing",   "Tailblocks split hero: text left, image right"),
    "tb-hero-b":        ("hero/light/b.js",         "marketing",   "Tailblocks centered hero with image above text"),
    "tb-feature-a":     ("feature/light/a.js",      "marketing",   "Tailblocks 3-column feature section with icons"),
    "tb-pricing-a":     ("pricing/light/a.js",      "marketing",   "Tailblocks 4-tier pricing table with popular badge"),
    "tb-cta-a":         ("cta/light/a.js",          "marketing",   "Tailblocks inline call-to-action with headline and button"),
    "tb-stats-a":       ("statistic/light/a.js",    "marketing",   "Tailblocks 4-stat metrics grid"),
    "tb-testimonial-a": ("testimonial/light/a.js",  "marketing",   "Tailblocks testimonial section with 2 quote cards"),
    "tb-blog-a":        ("blog/light/a.js",         "marketing",   "Tailblocks 3-card blog post grid with meta"),
    "tb-contact-a":     ("contact/light/a.js",      "application", "Tailblocks contact form card over map background"),
    "tb-team-a":        ("team/light/a.js",         "marketing",   "Tailblocks 9-member team grid with avatars"),
    "tb-step-a":        ("step/light/a.js",         "marketing",   "Tailblocks 4-step process timeline with image"),
    "tb-footer-a":      ("footer/light/a.js",       "layout",      "Tailblocks multi-column footer with social icons"),
}

# SVG camelCase → kebab-case attribute map
SVG_ATTRS = {
    "strokeLinecap":    "stroke-linecap",
    "strokeLinejoin":   "stroke-linejoin",
    "strokeWidth":      "stroke-width",
    "strokeDasharray":  "stroke-dasharray",
    "strokeDashoffset": "stroke-dashoffset",
    "fillOpacity":      "fill-opacity",
    "fillRule":         "fill-rule",
    "clipRule":         "clip-rule",
    "clipPath":         "clip-path",
    "markerEnd":        "marker-end",
}


def fetch_jsx(path: str) -> str:
    url = f"{TAILBLOCKS_RAW}/{path}"
    print(f"  Fetching {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.read().decode("utf-8")


def _camel_to_kebab(s: str) -> str:
    return re.sub(r"([a-z0-9])([A-Z])", lambda m: m.group(1) + "-" + m.group(2).lower(), s)


def _convert_style_attr(m: re.Match) -> str:
    """Convert style={{ filter: "...", ... }} → style="filter: ...;" """
    inner = m.group(1)
    parts = []
    for kv in re.finditer(r'(\w+)\s*:\s*"([^"]*)"', inner):
        key = _camel_to_kebab(kv.group(1))
        val = kv.group(2)
        parts.append(f"{key}: {val}")
    if parts:
        return 'style="' + "; ".join(parts) + '"'
    # fallback: return as-is stripped
    return m.group(0)


def _convert_self_closing(m: re.Match) -> str:
    """<tag attrs /> → <tag attrs> for void elements, keep /> otherwise."""
    VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input",
            "link", "meta", "param", "source", "track", "wbr"}
    tag = m.group(1)
    attrs = m.group(2)
    if tag.lower() in VOID:
        return f"<{tag}{attrs}>"
    # Non-void self-closing (rare in these blocks): keep as-is
    return m.group(0)


def jsx_to_html(jsx: str) -> str:
    """Extract the JSX return body from a component file and convert to HTML."""

    # ── 1. Extract the JSX between return ( ... ) ────────────────────────────
    # Handles both `return (...);` and `return (...)` (no semicolon)
    match = re.search(r"return\s*\(\s*([\s\S]*?)\s*\);?\s*\}", jsx)
    if not match:
        match = re.search(r"return\s*\(\s*([\s\S]*?)\s*\);?", jsx)
    if not match:
        raise ValueError("Could not locate JSX return statement")

    html = match.group(1).strip()

    # ── 2. Resolve theme template literals ──────────────────────────────────
    html = html.replace("${props.theme}", "indigo")

    # ── 3. className={`...`} → class="..." ──────────────────────────────────
    html = re.sub(
        r'className=\{`([^`]*)`\}',
        lambda m: f'class="{m.group(1)}"',
        html,
    )

    # ── 4. className="..." → class="..." ────────────────────────────────────
    html = re.sub(r"\bclassName=", "class=", html)

    # ── 5. htmlFor="..." → for="..." ────────────────────────────────────────
    html = re.sub(r"\bhtmlFor=", "for=", html)

    # ── 6. Bare `href` (no = follows) → href="#" ────────────────────────────
    html = re.sub(r"\bhref(?!\s*=)", 'href="#"', html)

    # ── 7. SVG camelCase attrs → kebab-case ─────────────────────────────────
    for camel, kebab in SVG_ATTRS.items():
        html = html.replace(camel + "=", kebab + "=")

    # ── 8. {N} numeric/boolean JSX attr values → "N" ────────────────────────
    html = re.sub(r"=\{(\d+(?:\.\d+)?)\}", r'="\1"', html)

    # ── 9. style={{ ... }} → style="..." ────────────────────────────────────
    html = re.sub(r"style=\{\{([\s\S]*?)\}\}", _convert_style_attr, html)

    # ── 10. Remove JSX block comments {/* ... */} ────────────────────────────
    html = re.sub(r"\{/\*[\s\S]*?\*/\}", "", html)

    # ── 11. Self-closing tags: void elements drop />, others keep as-is ─────
    html = re.sub(r"<([a-zA-Z][a-zA-Z0-9]*)((?:\s[^>]*?)?)\s*/>", _convert_self_closing, html)

    return html.strip()


def main():
    src_dir = Path(__file__).parent.parent / "src"
    registry_path = src_dir / "registry.json"
    toon_path = src_dir / "menu.toon"

    # Load existing registry
    with open(registry_path, encoding="utf-8") as f:
        registry = json.load(f)

    # Load existing TOON lines (skip header line)
    existing_toon = toon_path.read_text(encoding="utf-8").splitlines()
    toon_lines = [l for l in existing_toon[1:] if l.strip()]  # drop header

    added = 0
    for comp_id, (path, category, description) in TAILBLOCKS_MANIFEST.items():
        print(f"Processing: {comp_id}")
        try:
            jsx = fetch_jsx(path)
            html = jsx_to_html(jsx)

            registry[comp_id] = {
                "category": category,
                "description": description,
                "html": html,
            }

            short_desc = description[:50]
            toon_line = f"{comp_id},{category},{short_desc}"
            # Replace if already present, otherwise append
            toon_lines = [l for l in toon_lines if not l.startswith(comp_id + ",")]
            toon_lines.append(toon_line)

            print(f"  ✓ {comp_id} ({len(html)} chars)")
            added += 1
        except Exception as e:
            print(f"  ✗ Failed {comp_id}: {e}", file=sys.stderr)

    # Write updated registry
    with open(registry_path, "w", encoding="utf-8") as f:
        json.dump(registry, f, indent=2, ensure_ascii=False)
    print(f"\n✓ registry.json updated ({len(registry)} total components) → {registry_path}")

    # Write updated TOON
    toon_header = f"components[{len(toon_lines)}]{{id,category,desc}}:"
    with open(toon_path, "w", encoding="utf-8") as f:
        f.write(toon_header + "\n" + "\n".join(toon_lines) + "\n")
    print(f"✓ menu.toon updated ({len(toon_lines)} components) → {toon_path}")
    print(f"\nAdded {added} Tailblocks components.")


if __name__ == "__main__":
    main()
