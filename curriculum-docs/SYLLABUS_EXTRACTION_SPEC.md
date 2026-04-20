# Cambridge Syllabus Extraction Spec — Phase 1

This document is the output of **Phase 1 (Discovery & extraction spec)** for the
syllabus intelligence feature. It catalogues every Cambridge PDF under
`curriculum-docs/cambridge/syllabi/`, identifies the structural patterns the
PDFs follow, and fixes the JSON shape that the Phase 3 ingestion pipeline must
emit per subject.

No code or database changes are made in Phase 1. The database schema (Phase 2)
and the ingestion code (Phase 3) are driven by this document.

---

## 1. PDF catalogue

Source: `curriculum-docs/cambridge/syllabi/` (Cambridge International). Filename
shape: `<Subject>_<SyllabusCode>_<Years>.pdf`.

### 1.1 IGCSE (15 PDFs — directory `syllabi/IGCSE/`)

| Subject | Syllabus code | Years | File |
|---|---|---|---|
| Accounting | 0452 | 2027–2029 | `Accounting_0452_2027-2029.pdf` |
| Additional Mathematics | 0606 | 2028–2030 | `Additional_Mathematics_0606_2028-2030.pdf` |
| Biology | 0610 | 2026–2028 | `Biology_0610_2026-2028.pdf` |
| Business Studies | 0450 | 2026 | `Business_Studies_0450_2026.pdf` |
| Chemistry | 0620 | 2026–2028 | `Chemistry_0620_2026-2028.pdf` |
| Computer Science | 0478 | 2026–2028 | `Computer_Science_0478_2026-2028.pdf` |
| Design and Technology | 0445 | 2028–2030 | `Design_and_Technology_0445_2028-2030.pdf` |
| Economics | 0455 | 2027–2029 | `Economics_0455_2027-2029.pdf` |
| English First Language | 0500 | 2027–2029 | `English_First_Language_0500_2027-2029.pdf` |
| French (Foreign Language) | 0520 | 2028–2030 | `French_Foreign_Language_0520_2028-2030.pdf` |
| Geography | 0460 | 2027–2029 | `Geography_0460_2027-2029.pdf` |
| History | 0470 | 2027–2028 | `History_0470_2027-2028.pdf` |
| Literature in English | 0475 | 2027 | `Literature_in_English_0475_2027.pdf` |
| Mathematics | 0580 | 2028–2030 | `Mathematics_0580_2028-2030.pdf` |
| Physics | 0625 | 2026–2028 | `Physics_0625_2026-2028.pdf` |

Cambridge note (from `Syllabus_Index_and_Notes.pdf`): Business Studies 0450
becomes Cambridge IGCSE Business **0264** from first assessment March 2027.
Phase 3 must ingest 0450 as "current", and carry a `successorSyllabusCode`
field on the `syllabi` row for 0264 → future replacement.

### 1.2 A Level (17 filenames, **14 distinct syllabi** — directory `syllabi/A_Level/`)

| Subject | Syllabus code | Years | File |
|---|---|---|---|
| Accounting | 9706 | 2026–2028 | `Accounting_9706_2026-2028.pdf` |
| Biology | 9700 | 2028–2030 | `Biology_9700_2028-2030.pdf` |
| Business | 9609 | 2026–2028 | `Business_9609_2026-2028.pdf` |
| Chemistry | 9701 | 2028–2030 | `Chemistry_9701_2028-2030.pdf` |
| Computer Science | 9618 | 2027–2029 | `Computer_Science_9618_2027-2029.pdf` |
| Design and Technology | 9705 | 2028–2030 | `Design_and_Technology_9705_2028-2030.pdf` |
| Economics | 9708 | 2026–2028 | `Economics_9708_2026-2028.pdf` |
| English Language | 9093 | 2027–2028 | `English_Language_9093_2027-2028.pdf` |
| French | 9898 | 2025–2027 | `French_9898_2025-2027_replaces_9716.pdf` |
| Geography | 9696 | 2027–2029 | `Geography_9696_2027-2029.pdf` |
| History | 9489 | 2027–2029 | `History_9489_2027-2029.pdf` |
| Literature in English | 9695 | 2027–2028 | `Literature_in_English_9695_2027-2028.pdf` |
| Mathematics | 9709 | 2028–2030 | `Mathematics_9709_2028-2030.pdf` |
| Physics | 9702 | 2028–2030 | `Physics_9702_2028-2030.pdf` |

Important de-duplication:

- The files `Mathematics_9709_*.pdf`, `Mechanics_9709_*.pdf`,
  `Pure_Mathematics_9709_*.pdf`, `Statistics_9709_*.pdf` are **byte-identical**
  (md5 `1214d2f05e977a27f00b0dd2f8c37530`). 9709 is a single Cambridge syllabus
  with Pure Mathematics, Mechanics and Probability & Statistics as paper-route
  options. Phase 3 must ingest 9709 **exactly once**. The "Mechanics", "Pure
  Mathematics", "Statistics" labels are **strands inside 9709**, not separate
  subjects.
- French 9898 replaces 9716. Ingest as 9898 only.

Total distinct syllabi to ingest: **15 IGCSE + 14 A Level = 29**.

---

## 2. Structural patterns across Cambridge syllabi

From sample-parsing `Mathematics_9709`, `Physics_9702`, `Chemistry_9701`,
`Biology_9700`, `Economics_9708`, `Biology_0610`, `Mathematics_0580`, four
distinct structural patterns emerge. The ingestion pipeline (Phase 3) must
handle all four with one JSON output shape.

### Pattern A — Sciences with disjoint AS / A2 topic blocks

Observed in: **Physics 9702, Chemistry 9701, Biology 9700**.

- Fixed 5-paper layout: Paper 1 (MCQ AS), Paper 2 (Structured AS), Paper 3
  (Practical AS), Paper 4 (Structured A2), Paper 5 (Planning/Analysis/Eval A2).
- Topics are numbered as a single sequence; the syllabus states explicitly
  "AS Level candidates study topics 1–N" and "A Level candidates study the AS
  topics and the following topics N+1–M".
- Paper 4 assumes AS content; it is still an A2 paper because it is only taken
  by A Level candidates.
- Topics are grouped into **strands** (e.g. Chemistry 9701: Physical /
  Inorganic / Organic / Analysis).
- Every subtopic carries a "Candidates should be able to …" bullet list — these
  are the **learning requirements** and each bullet begins with a Cambridge
  command word (Describe, Calculate, Explain, …).

Examples:
- Physics 9702 — AS = topics 1–11, A2 = 12–25.
- Chemistry 9701 — AS = topics 1–22, A2 = 23–37.

### Pattern B — Paper-keyed component topics (Mathematics 9709)

- 6 paper components, each a self-contained topic cluster with its own
  subtopic numbering:
  - Paper 1 — Pure Mathematics 1  (§1.1 – §1.8)
  - Paper 2 — Pure Mathematics 2  (§2.1 – §2.6)
  - Paper 3 — Pure Mathematics 3  (§3.1 – §3.9)
  - Paper 4 — Mechanics           (§4.1 – §4.5)
  - Paper 5 — Probability & Statistics 1 (§5.1 – §5.5)
  - Paper 6 — Probability & Statistics 2 (§6.1 – §6.5)
- AS vs A2 is decided by which papers a candidate sits:
  - AS papers: **1, 2, 4, 5**
  - A2 papers: **3, 6** (alongside Paper 1 which is a prerequisite)
- Paper 2 content is **largely a subset** of Paper 3 content — so Pure 2 and
  Pure 3 topic names overlap (Algebra, Trigonometry, Differentiation,
  Integration, Numerical solution of equations, Logarithmic & exponential
  functions). The ingestion pipeline must keep them as separate topic rows
  (one under Paper 2, one under Paper 3) and let the UI de-duplicate by name
  at display time if desired.
- Mechanics, Probability & Statistics are **strands** inside 9709, **not**
  separate subjects. "Mechanics" and "Statistics" must not appear as
  `subjects.name` — they map to `papers.title` / `topics.strand`.

### Pattern C — Shared themes with AS/A2 subtopic split (Economics 9708)

- Topics are named **themes** that span both tiers. Each theme carries
  AS-numbered subtopics and A2-numbered subtopics side by side. Example:

  ```
  Theme: "The price system and the microeconomy"
    AS subtopics: 2.1–2.5
    A2 subtopics: 7.1–7.8
  ```

- Subtopic numbering range determines tier:
  - AS = sections 1–6 (subtopics 1.1 through 6.5)
  - A2 = sections 7–11 (subtopics 7.1 through 11.6)
- Papers: Paper 1 (MCQ AS), Paper 2 (Data Response/Essays AS), Paper 3 (MCQ A2),
  Paper 4 (Data Response/Essays A2).
- **Critical design implication:** a topic can be visible at both AS and A2 but
  with different subtopic sets. Therefore `levelTier` must live on
  **subtopic**, and the topic's tier visibility is computed as the union of
  its subtopics' tiers.

### Pattern D — IGCSE Core / Extended (Biology 0610, Mathematics 0580, etc.)

- One flat numbered topic list (9 topics for 0580, 21 for 0610).
- Each topic has a two-column layout: **Core** statements and **Supplement**
  (Extended-only) statements. Subtopics must be tagged `coreOrExtended: "core"
  | "extended"`.
- Papers: 1 & 3 = Core, 2 & 4 = Extended, 5 & 6 = Practical (or Alt-to-Prac).
- IGCSE does not use AS/A2. Ingestion sets every subtopic's `levelTier` to
  `IGCSE`, plus the `coreOrExtended` attribute above for the paper mapping.
- For Phase 5 UI: IGCSE tutors see the full topic list. Core/Extended can be
  surfaced as a secondary filter later — it is not in the user's required UI
  for this feature.

### Common elements across all four patterns

- **Assessment objectives** (AO1 / AO2 / AO3): every syllabus declares them in
  its front matter with percentage weightings per paper. These are the raw
  source for the **competencies** table. Typical mapping:

  | AO text snippet | Competency tag |
  |---|---|
  | "Knowledge and understanding" | `knowledge`, `understanding` |
  | "Application" / "Handling information" | `application` |
  | "Analysis" / "Analyse" | `analysis` |
  | "Evaluation" / "Evaluate" | `evaluation` |
  | "Experimental skills and investigations" | `practical_skills` |
  | "Interpret" | `interpretation` |
  | "Calculate" / numeric AOs | `calculation` |
  | "Solve problems" | `problem_solving` |

- **Command words** appendix (Calculate, Compare, Define, Describe, Determine,
  Explain, Give, Identify, Justify, Predict, Show, Sketch, State, Suggest,
  Use, Analyse, Evaluate, Deduce, Discuss, Estimate). The **first word of each
  "Candidates should be able to" bullet** is the command word for that
  learning requirement and maps deterministically to a competency tag. This is
  how Phase 3 assigns competencies per subtopic without an extra LLM pass.

---

## 3. Canonical JSON shape per syllabus

Phase 3 must emit exactly one JSON object per syllabus in the following shape.
All fields except those marked optional are required. Unknown values must be
`null`, never `""` or omitted.

```jsonc
{
  "examiningBody": "Cambridge",
  "level": "IGCSE" | "A_Level",          // top-level level band; AS/A2 live below
  "subject": "Physics",                   // canonical subject name
  "syllabusCode": "9702",
  "syllabusTitle": "Cambridge International AS & A Level Physics",
  "yearsValid": { "from": 2028, "to": 2030 },
  "sourceFile": "A_Level/Physics_9702_2028-2030.pdf",
  "contentHash": "sha256:...",            // of the source PDF bytes, for idempotency

  "assessmentObjectives": [
    {
      "code": "AO1",
      "title": "Knowledge and understanding",
      "description": "…",
      "competencyTags": ["knowledge", "understanding"],
      "weighting": { "AS": 40, "A_Level": 40 }
    }
    // AO2, AO3, …
  ],

  "papers": [
    {
      "paperNumber": 1,
      "code": "9702/01",
      "title": "Multiple Choice",
      "levelTier": "AS",                  // "AS" | "A2" | "IGCSE_Core" | "IGCSE_Extended" | "IGCSE_Practical"
      "durationMinutes": 75,
      "rawMarks": 40,
      "weightingPct": { "AS": 31, "A_Level": 15.5 },
      "style": "multiple_choice",         // free-text classifier
      "assumesPriorContentFrom": []       // other paperNumbers whose content this paper assumes
    }
    // Paper 2..5
  ],

  "strands": [                            // optional grouping above topics
    { "name": "Physical chemistry" },
    { "name": "Inorganic chemistry" }
    // …
  ],

  "topics": [
    {
      "topicNumber": "1",                 // string; Cambridge uses "1", "1.1", etc.
      "title": "Physical quantities and units",
      "strand": null,                     // nullable; set for Pattern A sciences & 9709 Mechanics/P&S
      "paperNumbers": [1, 2, 3],          // which papers can test this topic
      "levelTiers": ["AS"],               // union of tiers of its subtopics; computed
      "description": "…",                 // one-paragraph summary, from syllabus overview

      "subtopics": [
        {
          "subtopicNumber": "1.1",
          "title": "Physical quantities",
          "levelTier": "AS",              // authoritative; topic.levelTiers is derived from these
          "coreOrExtended": null,         // required for IGCSE, null for A Level
          "paperNumbers": [1, 2, 3],      // papers that can assess this subtopic
          "description": "…",

          "learningRequirements": [
            {
              "statement": "understand that all physical quantities consist of a numerical magnitude and a unit",
              "commandWord": "understand",
              "competencyTags": ["knowledge", "understanding"]
            }
            // one entry per "Candidates should be able to" bullet
          ]
        }
      ]
    }
  ],

  "paperTopicMappings": [                 // authoritative paper ↔ topic cross-reference
    { "paperNumber": 1, "topicNumber": "1", "weight": "covered" },
    { "paperNumber": 4, "topicNumber": "12", "weight": "covered" }
    // weight ∈ { "covered", "assumed", "primary" }
  ],

  "commandWordGlossary": [                // syllabus-level glossary, used for validation
    { "word": "Calculate", "meaning": "work out from given facts, figures or information" }
  ],

  "notes": [
    "Paper 2 subject content is largely a subset of Paper 3 subject content.",
    "Business Studies 0450 is replaced by Business 0264 from March 2027."
  ]
}
```

### 3.1 Rules the ingestion pipeline must enforce

1. **Deterministic level tiering:** `subtopic.levelTier` is set from the PDF,
   never guessed. If a subtopic cannot be placed deterministically in a tier,
   the ingestion must fail loudly — not default to AS.
2. **Topic tier is derived:** `topic.levelTiers` is the sorted deduped union of
   its subtopics' tiers. Tutors filtering by AS see every topic whose
   `levelTiers` contains `"AS"`.
3. **Paper-to-topic mapping:** every topic must appear in at least one
   `paperTopicMappings` row. For Pattern A/D the mapping is (AS tier → AS
   papers; A2 tier → A2 papers). For Pattern B it is one-to-one (topic → its
   declared paper). For Pattern C each subtopic's paper set is inherited by
   the topic.
4. **Command word → competency mapping** is deterministic (see §2). No LLM
   call required once the bullet text is captured.
5. **Idempotency:** the ingestion upserts by `(examiningBody, syllabusCode)`
   and re-runs are no-ops when `contentHash` matches the stored value.
6. **9709 exception:** only one of the four 9709 filenames is ingested. The
   chosen file is `A_Level/Mathematics_9709_2028-2030.pdf`. Strands
   `"Pure Mathematics"`, `"Mechanics"`, `"Probability & Statistics"` appear on
   topics, not on the subject.

---

## 4. Subject naming (canonical values)

The catalogue's `subjects.name` must use these exact canonical strings. Any
filename variation is normalised on ingestion.

```
Accounting
Additional Mathematics       — IGCSE only
Biology
Business                     — A Level uses "Business"; IGCSE 0450 uses "Business Studies"
Chemistry
Computer Science
Design and Technology
Economics
English                      — IGCSE "English First Language" (0500) and A Level "English Language" (9093) both map here
French
Geography
History
Literature in English
Mathematics
Physics
```

Notes:
- `Mechanics` and `Statistics` are **not** subjects. They are strands inside
  Mathematics 9709 (A Level).
- IGCSE `Additional Mathematics` (0606) is a distinct subject from
  `Mathematics` (0580).
- IGCSE `Business Studies` (0450) and A Level `Business` (9609) should share
  the `Business` subject row; the syllabi distinguish them.

---

## 5. Extraction method (Phase 3 preview — not built yet)

For each PDF:

1. Extract layout-preserving text with `pdftotext -layout` (already
   available — installed in Phase 1).
2. Segment the document using deterministic anchors found in every Cambridge
   syllabus:
   - `^\s*\d+\s+Why choose this syllabus\?`  → front matter start
   - `^\s*2\s+Syllabus overview`              → paper & content overview
   - `^\s*3\s+Subject content`                → topics / subtopics / learning
     requirements
   - `^\s*4\s+Details of the assessment`      → paper specifics
   - `^\s*Command words` (appendix)           → command-word glossary
3. Apply the pattern classifier (A/B/C/D) by inspecting the "Content overview"
   block:
   - Two-column "AS Level topics | A Level topics" header → Pattern C.
   - "AS Level subject content | A Level subject content" or
     "AS topics … and the following topics" → Pattern A.
   - "<Component> components: Paper N: …" block → Pattern B.
   - "Candidates study the following topics" with a Core/Extended header on
     subject-content pages → Pattern D.
4. Parse topics/subtopics deterministically for patterns A, B, D (the numbered
   headings and bullet structure are highly regular). Use a small LLM call
   **only** for free-text description fields where regex extraction is
   unreliable, and never for the classification itself.
5. For each "Candidates should be able to" bullet, capture the command word
   (first word) and run it through the fixed command-word → competency map.
6. Emit one JSON file per syllabus under
   `curriculum-docs/cambridge/extracted/<syllabusCode>.json` (new directory —
   created in Phase 3). Commit these JSON files so they are reviewable in PRs
   before being pushed into the database.

---

## 6. Risks & assumptions surfaced in Phase 1

1. **Non-technical A Level subjects** (History 9489, Geography 9696, Literature
   9695, Languages 9093 / 9898) have narrative content structures rather than
   numbered subtopics. Phase 1 did not deep-sample these; Phase 3 must confirm
   which of patterns A/B/C they follow or introduce a Pattern E for them. The
   current spec is confident for every science + Mathematics + Economics +
   Accounting + Business + Computer Science subject at both levels.
2. **9709 Paper 2 ⊂ Paper 3** overlap: the UI will show duplicate topic names
   ("Algebra", "Differentiation", …) under AS and A2. Acceptable at Phase 1;
   we can add a `mergeKey` on topic later if tutors complain.
3. **IGCSE Business 0450 → 0264**: ingest 0450 now; add a migration path when
   0264 PDF is added to the repo.
4. **Existing data paths**: `server/services/curriculumContent.ts` holds a
   hardcoded topic list, and `/api/tutor/syllabus-topics` reads the flat
   `syllabusTopicInventory` table (topic + subtopic + description only). Both
   are insufficient for syllabus intelligence and will be replaced in
   Phases 2–4. They stay live until Phase 5 cuts over the frontend.
5. **PDF libraries**: the repo has a hand-rolled `parsePdfTextFromBuffer` in
   `server/services/aiPipeline.ts` that only reads `Tj`/`TJ` operators. The
   ingestion pipeline should use `pdftotext -layout` at build time rather
   than that runtime parser, which was written for user-uploaded documents.

---

## 7. Deliverables checklist

- [x] Catalogue of 32 filenames → 29 distinct syllabi (de-duplicated).
- [x] Structural patterns A/B/C/D documented with sample subjects.
- [x] Canonical subject naming decided.
- [x] JSON shape per syllabus fixed.
- [x] Extraction method and deterministic anchors fixed.
- [x] Risks listed for Phase 3 to retire.

Phase 2 (database schema) now has everything it needs to start.
