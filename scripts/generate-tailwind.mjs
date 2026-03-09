/**
 * Generates public/tailwind.css by scanning all Tailwind classes used in
 * src/registry.json and compiling them with @tailwindcss/node.
 *
 * Run automatically before dev/build via package.json scripts.
 */
import { compile } from '@tailwindcss/node';
import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const root = resolve(import.meta.dirname, '..');
const registry = JSON.parse(readFileSync(resolve(root, 'src/registry.json'), 'utf8'));

// Extract all Tailwind utility class tokens from the registry HTML
const allHtml = Object.values(registry).map((c) => c.html).join(' ');
const candidates = new Set();
const classAttr = /class="([^"]+)"/g;
let m;
while ((m = classAttr.exec(allHtml)) !== null) {
  for (const cls of m[1].split(/\s+/)) if (cls) candidates.add(cls);
}

const result = await compile('@import "tailwindcss";', {
  base: root,
  onDependency: () => {},
});
const css = result.build([...candidates]);

mkdirSync(resolve(root, 'public'), { recursive: true });
writeFileSync(resolve(root, 'public/tailwind.css'), css);
console.log(`[generate-tailwind] ${candidates.size} candidates → ${css.length} bytes → public/tailwind.css`);
