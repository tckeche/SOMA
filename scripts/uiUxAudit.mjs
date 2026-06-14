#!/usr/bin/env node
// Playwright UI/UX auditor for SOMA.
// Crawls routes across desktop + mobile viewports, captures screenshots, and
// runs concrete heuristic checks (layout overflow, contrast, tap-target size,
// missing alt/labels, console/page errors).
//
// Usage:
//   node scripts/uiUxAudit.mjs                       # public routes only
//   node scripts/uiUxAudit.mjs --routes=/,/login     # custom routes
//   BASE_URL=http://localhost:5000 node scripts/uiUxAudit.mjs
//
// Auth (optional, to reach gated pages): set SOMA_EMAIL + SOMA_PASSWORD and the
// script will log in via /login before crawling.

import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE_URL = process.env.BASE_URL || "http://localhost:5000";
const OUT_DIR = ".local/ui-audit";

const argRoutes = (process.argv.find((a) => a.startsWith("--routes=")) || "")
  .replace("--routes=", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const PUBLIC_ROUTES = ["/", "/login", "/forgot-password"];
const ROUTES = argRoutes.length ? argRoutes : PUBLIC_ROUTES;

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844, isMobile: true, hasTouch: true },
];

const slug = (r) => (r === "/" ? "home" : r.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, ""));

// Heuristics that run inside the page.
function inPageAudit() {
  const issues = [];
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // 1) Horizontal overflow (causes ugly side-scroll on mobile).
  const docW = document.documentElement.scrollWidth;
  if (docW > vw + 1) {
    const offenders = [];
    document.querySelectorAll("*").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > vw + 1) {
        offenders.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className && String(el.className).slice(0, 60)) || "",
          right: Math.round(r.right),
        });
      }
    });
    issues.push({ type: "horizontal-overflow", severity: "high", docW, vw, offenders: offenders.slice(0, 6) });
  }

  // 2) Images without alt text.
  const imgsNoAlt = [...document.querySelectorAll("img")].filter(
    (i) => !i.getAttribute("alt") && !i.getAttribute("aria-hidden") && i.getBoundingClientRect().width > 0,
  );
  if (imgsNoAlt.length) {
    issues.push({
      type: "img-missing-alt",
      severity: "medium",
      count: imgsNoAlt.length,
      examples: imgsNoAlt.slice(0, 5).map((i) => (i.currentSrc || i.src || "").slice(0, 80)),
    });
  }

  // 3) Interactive elements without an accessible name.
  const namelessControls = [];
  document.querySelectorAll('button, a, [role="button"], input, select, textarea').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const name =
      (el.getAttribute("aria-label") || "").trim() ||
      (el.getAttribute("title") || "").trim() ||
      (el.textContent || "").trim() ||
      (el.getAttribute("placeholder") || "").trim() ||
      (el.tagName === "INPUT" && el.labels && el.labels.length ? "labelled" : "");
    if (!name) {
      namelessControls.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || "").slice(0, 50) });
    }
  });
  if (namelessControls.length) {
    issues.push({ type: "control-without-name", severity: "medium", count: namelessControls.length, examples: namelessControls.slice(0, 6) });
  }

  // 4) Small tap targets (< 40px on a touch viewport hurts usability).
  const smallTargets = [];
  document.querySelectorAll('button, a, [role="button"], input[type="checkbox"], input[type="radio"]').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    if (r.width < 40 || r.height < 40) {
      smallTargets.push({ tag: el.tagName.toLowerCase(), w: Math.round(r.width), h: Math.round(r.height), txt: (el.textContent || "").trim().slice(0, 24) });
    }
  });
  if (smallTargets.length) {
    issues.push({ type: "small-tap-target", severity: "low", count: smallTargets.length, examples: smallTargets.slice(0, 8) });
  }

  // 5) Low-contrast text (WCAG AA: 4.5 for normal text, 3.0 for large).
  function parseRGB(s) {
    const m = s.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(",").map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] };
  }
  function lum({ r, g, b }) {
    const f = (c) => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  function effectiveBg(el) {
    let node = el;
    while (node && node !== document.documentElement) {
      const bg = parseRGB(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0.5) return bg;
      node = node.parentElement;
    }
    return { r: 10, g: 10, b: 20, a: 1 }; // app is dark-themed
  }
  const lowContrast = [];
  const seen = new Set();
  document.querySelectorAll("p, span, a, button, h1, h2, h3, h4, label, li, div").forEach((el) => {
    const txt = (el.childNodes.length ? [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join("") : "").trim();
    if (!txt || txt.length < 2) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > vh) return;
    const cs = getComputedStyle(el);
    if (parseFloat(cs.opacity) < 0.3) return;
    const fg = parseRGB(cs.color);
    if (!fg || fg.a < 0.3) return;
    const bg = effectiveBg(el);
    const L1 = lum(fg) + 0.05;
    const L2 = lum(bg) + 0.05;
    const ratio = L1 > L2 ? L1 / L2 : L2 / L1;
    const size = parseFloat(cs.fontSize);
    const bold = parseInt(cs.fontWeight) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    const threshold = large ? 3.0 : 4.5;
    if (ratio < threshold) {
      const key = txt.slice(0, 30) + size;
      if (!seen.has(key)) {
        seen.add(key);
        lowContrast.push({ text: txt.slice(0, 40), ratio: Math.round(ratio * 100) / 100, needs: threshold, size: Math.round(size), color: cs.color });
      }
    }
  });
  if (lowContrast.length) {
    issues.push({ type: "low-contrast-text", severity: "high", count: lowContrast.length, examples: lowContrast.slice(0, 12) });
  }

  // 6) Document / SEO basics.
  if (!document.title || document.title.trim().length < 3) issues.push({ type: "missing-title", severity: "medium" });
  if (!document.querySelector('meta[name="description"]')) issues.push({ type: "missing-meta-description", severity: "low" });
  const h1s = document.querySelectorAll("h1").length;
  if (h1s === 0) issues.push({ type: "no-h1", severity: "medium" });
  if (h1s > 1) issues.push({ type: "multiple-h1", severity: "low", count: h1s });

  return { issues, vw, vh, docW };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const report = { baseUrl: BASE_URL, generatedAt: new Date().toISOString(), pages: [] };

  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      isMobile: !!vp.isMobile,
      hasTouch: !!vp.hasTouch,
      deviceScaleFactor: vp.isMobile ? 2 : 1,
    });

    // Optional login.
    if (process.env.SOMA_EMAIL && process.env.SOMA_PASSWORD) {
      const lp = await context.newPage();
      try {
        await lp.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded", timeout: 30000 });
        await lp.fill('input[type="email"]', process.env.SOMA_EMAIL).catch(() => {});
        await lp.fill('input[type="password"]', process.env.SOMA_PASSWORD).catch(() => {});
        await lp.click('button[type="submit"]').catch(() => {});
        await lp.waitForTimeout(4000);
      } catch (e) {
        console.error("Login attempt failed:", e.message);
      }
      await lp.close();
    }

    for (const route of ROUTES) {
      const page = await context.newPage();
      const consoleErrors = [];
      const pageErrors = [];
      page.on("console", (m) => {
        if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
      });
      page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));

      let status = null;
      try {
        const resp = await page.goto(`${BASE_URL}${route}`, { waitUntil: "domcontentloaded", timeout: 30000 });
        status = resp ? resp.status() : null;
        await page.waitForTimeout(1200);
      } catch (e) {
        pageErrors.push("navigation: " + e.message);
      }

      const audit = await page.evaluate(inPageAudit).catch((e) => ({ issues: [{ type: "audit-eval-failed", severity: "high", msg: e.message }] }));
      const file = path.join(OUT_DIR, `${slug(route)}-${vp.name}.png`);
      await page.screenshot({ path: file, fullPage: true }).catch(() => {});

      report.pages.push({
        route,
        viewport: vp.name,
        status,
        screenshot: file,
        consoleErrors,
        pageErrors,
        ...audit,
      });

      const n = (audit.issues || []).length;
      console.log(`${vp.name.padEnd(7)} ${route.padEnd(20)} status=${status} issues=${n} consoleErr=${consoleErrors.length}`);
      await page.close();
    }
    await context.close();
  }

  await browser.close();
  await writeFile(path.join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));

  // Console summary by issue type.
  const tally = {};
  for (const p of report.pages) for (const i of p.issues || []) tally[i.type] = (tally[i.type] || 0) + 1;
  console.log("\n=== Issue tally (page-instances) ===");
  Object.entries(tally).sort((a, b) => b[1] - a[1]).forEach(([t, c]) => console.log(`  ${c}x  ${t}`));
  console.log(`\nReport: ${path.join(OUT_DIR, "report.json")}  |  Screenshots: ${OUT_DIR}/`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
