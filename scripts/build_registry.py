#!/usr/bin/env python3
"""
Registry Builder for Web Builder 2.0
Fetches real HyperUI components and builds registry.json + menu.toon

Usage:
  # Option 1: Use local HyperUI clone
  python3 build_registry.py --local ./hyperui/public/examples

  # Option 2: Fetch from GitHub (requires internet access)
  python3 build_registry.py --remote

  # Option 3 (default): Use bundled component definitions
  python3 build_registry.py

NOTE: To add/refresh Tailblocks components (mertJF/tailblocks), run:
  python3 scripts/convert_tailblocks.py
This fetches JSX from Tailblocks, converts it to static HTML,
and merges the results into registry.json and menu.toon.
"""

import os
import json
import re
import argparse
import urllib.request
from pathlib import Path

GITHUB_RAW_BASE = "https://raw.githubusercontent.com/markmead/hyperui/main/public/examples"

# Component manifest: id -> (remote_path, category, description)
COMPONENT_MANIFEST = {
    "nav-1":         ("marketing/headers/1.html",        "layout",      "Navbar with logo, nav links, and login/register buttons"),
    "hero-split":    ("marketing/ctas/1.html",           "marketing",   "Split-screen hero with text left and image right"),
    "stats-3col":    ("marketing/stats/1.html",          "marketing",   "4-column statistics grid with large numbers"),
    "cta-dark":      ("marketing/newsletter-signup/1.html","marketing",  "Newsletter signup with email input on gray background"),
    "pricing-tiers": ("marketing/pricing/1.html",        "marketing",   "2-tier pricing table with Pro and Starter plans"),
    "faq-accordion": ("marketing/faqs/1.html",           "marketing",   "Accordion-style FAQ using HTML details elements"),
    "footer-social": ("marketing/footers/1.html",        "layout",      "Large footer with nav links, newsletter, and social icons"),
    "contact-form":  ("marketing/contact-forms/1.html",  "application", "Contact form with name, email, message fields"),
    "hero-center":   ("marketing/sections/1.html",       "marketing",   "Two-column section with text left and image right"),
    "feature-grid":  ("marketing/feature-grids/1.html",  "marketing",   "Feature grid with icons and descriptions"),
    "logo-cloud":    ("marketing/logo-clouds/1.html",    "marketing",   "Logo cloud section for trusted brands"),
    "team-section":  ("marketing/team-sections/1.html",  "marketing",   "Team member cards grid section"),
    "blog-cards":    ("marketing/blog-cards/1.html",     "marketing",   "Blog post cards grid section"),
}


def extract_body(html: str) -> str:
    """Extract inner content of <body> tag, stripping the full page wrapper."""
    match = re.search(r'<body[^>]*>(.*?)</body>', html, re.DOTALL | re.IGNORECASE)
    if match:
        return match.group(1).strip()
    return html.strip()


def fetch_remote(path: str) -> str:
    url = f"{GITHUB_RAW_BASE}/{path}"
    print(f"  Fetching {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.read().decode("utf-8")


def fetch_local(base_dir: str, path: str) -> str:
    full_path = Path(base_dir) / path
    if not full_path.exists():
        raise FileNotFoundError(f"File not found: {full_path}")
    return full_path.read_text(encoding="utf-8")


def build_registry(source: str = "bundled", local_dir: str = None):
    registry = {}
    toon_lines = []

    for comp_id, (remote_path, category, description) in COMPONENT_MANIFEST.items():
        print(f"Processing: {comp_id}")
        try:
            if source == "remote":
                raw_html = fetch_remote(remote_path)
            elif source == "local":
                raw_html = fetch_local(local_dir, remote_path)
            else:
                # Bundled fallback - skip fetching
                print(f"  [bundled] Using placeholder for {comp_id}")
                raw_html = f"<body><div><!-- {comp_id} placeholder --></div></body>"

            body_content = extract_body(raw_html)

            registry[comp_id] = {
                "category": category,
                "description": description,
                "html": body_content,
            }

            # Truncate description for TOON (max 50 chars)
            short_desc = description[:50]
            toon_lines.append(f"{comp_id},{category},{short_desc}")
            print(f"  ✓ {comp_id} ({len(body_content)} chars)")

        except Exception as e:
            print(f"  ✗ Failed to process {comp_id}: {e}")

    # Output paths (relative to project root)
    output_dir = Path(__file__).parent.parent / "src"
    output_dir.mkdir(exist_ok=True)

    registry_path = output_dir / "registry.json"
    with open(registry_path, "w", encoding="utf-8") as f:
        json.dump(registry, f, indent=2, ensure_ascii=False)
    print(f"\n✓ registry.json written ({len(registry)} components) → {registry_path}")

    toon_header = f"components[{len(toon_lines)}]{{id,category,desc}}:"
    toon_path = output_dir / "menu.toon"
    with open(toon_path, "w", encoding="utf-8") as f:
        f.write(toon_header + "\n" + "\n".join(toon_lines) + "\n")
    print(f"✓ menu.toon written → {toon_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build HyperUI component registry")
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "--remote",
        action="store_true",
        help="Fetch components from GitHub (requires internet)",
    )
    group.add_argument(
        "--local",
        metavar="DIR",
        help="Path to local HyperUI clone's public/examples directory",
    )
    args = parser.parse_args()

    if args.remote:
        build_registry(source="remote")
    elif args.local:
        build_registry(source="local", local_dir=args.local)
    else:
        print("Usage: python3 build_registry.py --remote  OR  --local <path>")
        print("Running with --remote to fetch real HyperUI components...")
        build_registry(source="remote")
