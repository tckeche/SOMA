/**
 * 0470 Cambridge IGCSE History.
 *
 *   3 Subject content
 *     Core content: Option A        (nineteenth century, six key questions)
 *       <key question 1…6>
 *         Focus points              (bullets → LRs)
 *         Specified content         (bullets → LRs, appended to same subtopic)
 *     Core content: Option B        (twentieth century, six key questions)
 *       …same shape…
 *     Depth studies
 *       Depth study A               (four key questions, SHARED specified content)
 *         <key question 1…4>
 *           Focus points            (bullets → LRs on the subtopic)
 *         Specified content         (emits DA.S subtopic with all bullets)
 *       Depth studies B–E           (same shape; B has (a)/(b) sub-questions
 *                                    under key question 3)
 *   4 Details of the assessment
 *
 * Topic numbering (schema has no natural container for Option/Depth grouping,
 * so we prefix):
 *
 *   CA            Core Option A           Subtopics CA.1 … CA.6
 *   CB            Core Option B           Subtopics CB.1 … CB.6
 *   DA … DE       Depth study A … E       Subtopics D?.1 … D?.4, D?.S
 *                                         (D?.3 in Depth study B splits into
 *                                          DB.3a and DB.3b)
 *
 * Each option lists its six key questions twice — once as an overview
 * list immediately after the option banner, and again as detail headers
 * that introduce Focus points / Specified content. `ensureSubtopic` handles
 * this naturally: the first occurrence seeds the subtopic; the second
 * reuses it and we attach bullets during the detail pass.
 */

import type { LevelTier } from "@shared/schema";
import type { ParsedSyllabus } from "./types";
import {
  addRequirement,
  ensureSubtopic,
  ensureTopic,
  makeState,
  matchBullet,
  matchDash,
  sliceBetween,
  toParsedSyllabus,
} from "./patternE4";
import { collapseWhitespace } from "./shared";

const SECTION_START = /^3\s+Subject content$/;
const SECTION_END = /^4\s+Details of the assessment\b/;

// Container banners.
const CORE_A_BANNER = /^Core content:\s*Option\s+A\b/;
const CORE_B_BANNER = /^Core content:\s*Option\s+B\b/;
const DEPTH_BANNER = /^Depth study\s+([A-E]):\s*(.+?)\s*$/;

// Section role markers inside a key-question block.
const FOCUS_POINTS_RX = /^Focus points\s*$/;
const SPECIFIED_CONTENT_RX = /^Specified content\s*$/;

// "N   Title?" — a numbered key-question line (both overview and detail).
// Separator is a run of spaces, a tab, or a tab + bell-byte artefact that
// pdftotext emits on the detail rows.
const KEY_QUESTION_RX = /^\s{0,20}(\d)[ \t\u00A0\x07]+([A-Z].+?)\s*$/;

// "(a) Title?" / "(b) Title?" — sub-questions under Depth study B / key question 3.
const SUB_QUESTION_RX = /^\s{0,20}\(([a-z])\)\s+(.+?)\s*$/;

// Continuation of the prior subtopic title on a new line — any
// indented text that's not a bullet / number / banner. Used to stitch
// wrapped questions like "5 Why, and with what effects, did nations" /
// "    gain and expand their overseas empires…".
const CONTINUATION_RX = /^\s{10,}[A-Za-z].*$/;

// Banner at the top of Depth studies — precedes Depth study A.
const DEPTH_STUDIES_BANNER = /^Depth studies\s*$/;

type Mode =
  | "pre"
  | "core_a"
  | "core_b"
  | "depth_a"
  | "depth_b"
  | "depth_c"
  | "depth_d"
  | "depth_e";

type Section = "none" | "focus" | "specified";

interface WorkingCtx {
  mode: Mode;
  /** Subtopic prefix for the current container (e.g. "CA", "DB"). */
  prefix: string;
  /** Role of the current bullet stream. */
  section: Section;
  /** Most-recent key-question number within the container (1…6). */
  lastKeyQ: number | null;
  /** Sub-question tag when active (e.g. "a" / "b"), else null. */
  lastSubQ: string | null;
  /** True while we're still inside a key-question's title wrap. */
  titleContinuation: boolean;
}

function containerFor(mode: Mode): { prefix: string; tier: LevelTier; topicTitle: string } | null {
  switch (mode) {
    case "core_a":
      return { prefix: "CA", tier: "IGCSE", topicTitle: "Core content: Option A — The nineteenth century: the development of modern nation states, 1848–1914" };
    case "core_b":
      return { prefix: "CB", tier: "IGCSE", topicTitle: "Core content: Option B — The twentieth century: international relations from 1919" };
    case "depth_a":
      return { prefix: "DA", tier: "IGCSE", topicTitle: "Depth study A: The First World War, 1914–18" };
    case "depth_b":
      return { prefix: "DB", tier: "IGCSE", topicTitle: "Depth study B: Germany, 1918–45" };
    case "depth_c":
      return { prefix: "DC", tier: "IGCSE", topicTitle: "Depth study C: Russia, 1905–41" };
    case "depth_d":
      return { prefix: "DD", tier: "IGCSE", topicTitle: "Depth study D: The United States, 1919–41" };
    case "depth_e":
      return { prefix: "DE", tier: "IGCSE", topicTitle: "Depth study E: The Second World War in Europe and the Asia–Pacific, 1939–c.1945" };
    default:
      return null;
  }
}

export function parse0470(text: string): ParsedSyllabus {
  const state = makeState();
  const lines = sliceBetween(text.split(/\r?\n/), SECTION_START, SECTION_END);

  const ctx: WorkingCtx = {
    mode: "pre",
    prefix: "",
    section: "none",
    lastKeyQ: null,
    lastSubQ: null,
    titleContinuation: false,
  };

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) {
      ctx.titleContinuation = false;
      continue;
    }

    if (CORE_A_BANNER.test(trimmed)) {
      enterContainer(state, ctx, "core_a");
      continue;
    }
    if (CORE_B_BANNER.test(trimmed)) {
      enterContainer(state, ctx, "core_b");
      continue;
    }
    if (DEPTH_STUDIES_BANNER.test(trimmed)) {
      // Intro to depth-studies list; next real banner ("Depth study A:…")
      // switches mode. Reset state in the meantime.
      ctx.mode = "pre";
      ctx.prefix = "";
      ctx.section = "none";
      ctx.lastKeyQ = null;
      ctx.lastSubQ = null;
      ctx.titleContinuation = false;
      continue;
    }
    const depthMatch = DEPTH_BANNER.exec(trimmed);
    if (depthMatch) {
      const letter = depthMatch[1].toLowerCase();
      const mode = `depth_${letter}` as Mode;
      enterContainer(state, ctx, mode);
      continue;
    }

    if (ctx.mode === "pre") continue;

    if (FOCUS_POINTS_RX.test(trimmed)) {
      ctx.section = "focus";
      ctx.titleContinuation = false;
      continue;
    }
    if (SPECIFIED_CONTENT_RX.test(trimmed)) {
      ctx.section = "specified";
      ctx.titleContinuation = false;
      // In Depth mode the single Specified content block is its own subtopic.
      if (isDepth(ctx.mode)) {
        ensureSubtopic(state, `${ctx.prefix}.S`, "Specified content", containerFor(ctx.mode)!.tier);
        ctx.lastKeyQ = null;
        ctx.lastSubQ = null;
      }
      continue;
    }

    // Sub-question "(a) Title" inside Depth B key question 3.
    const subQ = SUB_QUESTION_RX.exec(raw);
    if (subQ && isDepth(ctx.mode) && ctx.lastKeyQ !== null) {
      const [, letter, title] = subQ;
      const number = `${ctx.prefix}.${ctx.lastKeyQ}${letter}`;
      ensureSubtopic(state, number, collapseWhitespace(title), containerFor(ctx.mode)!.tier);
      ctx.lastSubQ = letter;
      ctx.section = "none";
      ctx.titleContinuation = true;
      continue;
    }

    // Numbered key question "N   Title?".
    const kq = KEY_QUESTION_RX.exec(raw);
    if (kq) {
      const [, numStr, title] = kq;
      const n = Number(numStr);
      const number = `${ctx.prefix}.${n}`;
      ensureSubtopic(state, number, collapseWhitespace(title), containerFor(ctx.mode)!.tier);
      ctx.lastKeyQ = n;
      ctx.lastSubQ = null;
      ctx.section = "none";
      ctx.titleContinuation = true;
      continue;
    }

    // Bullet under Focus points / Specified content.
    const bullet = matchBullet(raw);
    if (bullet && state.activeSubtopic) {
      ctx.titleContinuation = false;
      addRequirement(state, bullet.text);
      continue;
    }

    // Nested dash — append to last requirement's notes.
    const dash = matchDash(raw);
    if (dash && state.activeSubtopic?.requirements.length) {
      ctx.titleContinuation = false;
      const last = state.activeSubtopic.requirements.at(-1)!;
      const joined = last.notesAndExamples
        ? `${last.notesAndExamples}; ${dash.text}`
        : dash.text;
      last.notesAndExamples = collapseWhitespace(joined);
      continue;
    }

    // Title wrap: a continuation line appearing right after a key-question
    // or sub-question header, before Focus points is reached. A title
    // already ending with terminal punctuation is complete — the overview
    // pass may have stitched it once, and the detail pass would otherwise
    // append the same continuation a second time.
    if (
      ctx.titleContinuation &&
      state.activeSubtopic &&
      CONTINUATION_RX.test(raw) &&
      ctx.section === "none"
    ) {
      if (!/[?.!]$/.test(state.activeSubtopic.title)) {
        state.activeSubtopic.title = collapseWhitespace(
          `${state.activeSubtopic.title} ${trimmed}`,
        );
      }
      continue;
    }

    // Bullet statement wrap (long bullets that spill onto the next line).
    if (!bullet && !dash && state.activeSubtopic?.requirements.length) {
      const last = state.activeSubtopic.requirements.at(-1)!;
      if (last.notesAndExamples) {
        last.notesAndExamples = collapseWhitespace(
          `${last.notesAndExamples} ${trimmed}`,
        );
      } else {
        last.statement = collapseWhitespace(`${last.statement} ${trimmed}`);
      }
    }
  }

  return toParsedSyllabus("0470", state);
}

function enterContainer(
  state: ReturnType<typeof makeState>,
  ctx: WorkingCtx,
  mode: Mode,
): void {
  const info = containerFor(mode);
  if (!info) return;
  ensureTopic(state, info.prefix, info.topicTitle, info.tier);
  ctx.mode = mode;
  ctx.prefix = info.prefix;
  ctx.section = "none";
  ctx.lastKeyQ = null;
  ctx.lastSubQ = null;
  ctx.titleContinuation = false;
}

function isDepth(mode: Mode): boolean {
  return mode.startsWith("depth_");
}
