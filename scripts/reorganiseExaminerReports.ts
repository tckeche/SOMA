/**
 * One-shot script: reorganise Cambridge examiner-report PDFs from the
 * upload-friendly layout (`curriculum-docs/cambridge/Examiner-reports/ER/`)
 * into the canonical layout the ingestion script expects:
 *
 *   curriculum-docs/cambridge/examiner-reports/<level>/<Subject>_<Code>_<Session>.pdf
 *
 * Where <level> is one of `igcse`, `as`, `a2`. A-Level reports without
 * a paper number cover both AS and A2, so they live under `as/` with a
 * relative symlink in `a2/`.
 *
 * Usage:
 *   npx tsx scripts/reorganiseExaminerReports.ts            # dry-run (prints table)
 *   npx tsx scripts/reorganiseExaminerReports.ts --execute  # actually move
 */
import fs from "fs";
import path from "path";

const ROOT = path.resolve(process.cwd(), "curriculum-docs/cambridge");
const SOURCE = path.join(ROOT, "Examiner-reports", "ER");
const DEST_BASE = path.join(ROOT, "examiner-reports");

// Code -> human subject. Built dynamically from the existing syllabi PDF
// filenames so we stay in lockstep with whatever the user has uploaded;
// a small fallback covers Cambridge codes whose syllabi aren't in the
// workspace yet (ICT, ESL).
const SYLLABI_ROOT = path.join(ROOT, "syllabi");
const FALLBACK_SUBJECTS: Record<string, string> = {
  "0417": "Information and Communication Technology",
  "0510": "English as a Second Language",
};

function buildCodeToSubject(): Map<string, string> {
  const map = new Map<string, string>();
  function walk(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.toLowerCase().endsWith(".pdf")) {
        const m = entry.name.match(/^(.+?)_(\d{4})_/);
        if (m) {
          const subject = m[1].replace(/_/g, " ").trim();
          const code = m[2];
          if (!map.has(code)) map.set(code, subject);
        }
      }
    }
  }
  walk(SYLLABI_ROOT);
  for (const [code, subject] of Object.entries(FALLBACK_SUBJECTS)) {
    if (!map.has(code)) map.set(code, subject);
  }
  return map;
}

const SESSION_NAMES: Record<string, string> = {
  s: "May-June",
  w: "Oct-Nov",
  m: "Feb-March",
};

function translateSession(token: string): string | null {
  const m = token.match(/^([smw])(\d{2})$/i);
  if (!m) return null;
  const code = m[1].toLowerCase();
  const yy = parseInt(m[2], 10);
  const year = 2000 + yy;
  const name = SESSION_NAMES[code];
  if (!name) return null;
  return `${year}-${name}`;
}

function inferLevel(code: string): "igcse" | "a-level" {
  if (/^0\d{3}$/.test(code)) return "igcse";
  return "a-level";
}

function subjectToToken(subject: string): string {
  return subject
    .split(/\s+/)
    .filter(Boolean)
    .join("_");
}

interface PlanEntry {
  source: string;
  destPrimary: string;
  destSymlink?: string;
  subject: string;
  code: string;
  session: string;
  level: "igcse" | "as+a2";
  reason?: string;
}

function planMoves(): { plan: PlanEntry[]; unmapped: string[] } {
  const codeToSubject = buildCodeToSubject();
  const plan: PlanEntry[] = [];
  const unmapped: string[] = [];

  function walk(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.toLowerCase().endsWith(".pdf")) {
        const base = entry.name;
        const m = base.match(/^(\d{4})_([smw]\d{2})_er\.pdf$/i);
        if (!m) {
          unmapped.push(`${full} — name doesn't match <code>_<session>_er.pdf`);
          continue;
        }
        const code = m[1];
        const sessionToken = m[2].toLowerCase();
        const session = translateSession(sessionToken);
        const subject = codeToSubject.get(code);
        if (!subject || !session) {
          unmapped.push(
            `${full} — ${!subject ? `unknown code ${code}` : `unparseable session ${sessionToken}`}`,
          );
          continue;
        }
        const newName = `${subjectToToken(subject)}_${code}_${session}.pdf`;
        const lvl = inferLevel(code);
        if (lvl === "igcse") {
          plan.push({
            source: full,
            destPrimary: path.join(DEST_BASE, "igcse", newName),
            subject,
            code,
            session,
            level: "igcse",
          });
        } else {
          // Whole-syllabus A-Level report (no paper number in filename) —
          // primary in `as/`, symlink in `a2/`.
          plan.push({
            source: full,
            destPrimary: path.join(DEST_BASE, "as", newName),
            destSymlink: path.join(DEST_BASE, "a2", newName),
            subject,
            code,
            session,
            level: "as+a2",
          });
        }
      }
    }
  }
  walk(SOURCE);
  return { plan, unmapped };
}

function printTable(plan: PlanEntry[]) {
  const summary = new Map<string, { igcse: number; both: number }>();
  for (const e of plan) {
    const key = `${e.code} ${e.subject}`;
    if (!summary.has(key)) summary.set(key, { igcse: 0, both: 0 });
    const s = summary.get(key)!;
    if (e.level === "igcse") s.igcse++;
    else s.both++;
  }
  console.log("\n=== Planned placement (per code) ===");
  console.log("Code  Subject                                      Level    Files");
  for (const [k, v] of [...summary.entries()].sort()) {
    const total = v.igcse + v.both;
    const lvl = v.igcse > 0 ? "igcse" : "as+a2";
    const subjectPart = k.slice(5).padEnd(44);
    console.log(`${k.slice(0, 4)}  ${subjectPart} ${lvl.padEnd(8)} ${total}`);
  }
  console.log(`\nTotal: ${plan.length} files`);
  console.log(`  IGCSE → curriculum-docs/cambridge/examiner-reports/igcse/`);
  console.log(`  A-Level (whole-syllabus) → as/ + symlink in a2/`);
}

function execute(plan: PlanEntry[]) {
  for (const sub of ["igcse", "as", "a2"]) {
    fs.mkdirSync(path.join(DEST_BASE, sub), { recursive: true });
  }
  let moved = 0;
  let symlinked = 0;
  let skipped = 0;
  for (const e of plan) {
    if (fs.existsSync(e.destPrimary)) {
      skipped++;
    } else {
      fs.renameSync(e.source, e.destPrimary);
      moved++;
    }
    if (e.destSymlink) {
      if (fs.existsSync(e.destSymlink)) {
        // Already there (re-run safe)
      } else {
        const rel = path.relative(path.dirname(e.destSymlink), e.destPrimary);
        fs.symlinkSync(rel, e.destSymlink);
        symlinked++;
      }
    }
  }
  console.log(`\nMoved: ${moved} | Symlinked: ${symlinked} | Already-in-place: ${skipped}`);
}

function main() {
  const isExecute = process.argv.includes("--execute");
  const { plan, unmapped } = planMoves();
  printTable(plan);
  if (unmapped.length > 0) {
    console.log(`\n=== UNMAPPED (${unmapped.length}) ===`);
    for (const u of unmapped) console.log(`  ${u}`);
  }
  if (!isExecute) {
    console.log("\nDry-run only. Re-run with --execute to perform the moves.");
    return;
  }
  execute(plan);
  console.log("\nDone.");
}

main();
