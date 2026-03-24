# Curriculum Documents

This folder is the source library for syllabus PDFs and examiner report PDFs used by SOMA's AI copilot.

---

## Folder Structure

```
curriculum-docs/
└── cambridge/
    ├── syllabi/
    │   ├── igcse/     ← IGCSE syllabus PDFs
    │   ├── as/        ← AS Level syllabus PDFs
    │   └── a2/        ← A2 Level syllabus PDFs
    └── examiner-reports/
        ├── igcse/     ← IGCSE examiner report PDFs
        ├── as/        ← AS Level examiner report PDFs
        └── a2/        ← A2 Level examiner report PDFs
```

---

## How to Add Documents

1. Place syllabus PDFs in the appropriate `syllabi/` subfolder.
2. Place examiner report PDFs in the appropriate `examiner-reports/` subfolder.
3. Run the ingestion command (see below).

**Important:** Do NOT place documents in the `client/` or `public/` folders. This folder (`curriculum-docs/`) is server-side only.

---

## Recommended Naming Convention

Clear filenames make metadata inference more accurate, but are not strictly required.

### Syllabi
```
0580_igcse_mathematics_syllabus.pdf
9709_as_mathematics_syllabus.pdf
9709_a2_mathematics_syllabus.pdf
0625_igcse_physics_syllabus.pdf
9702_as_physics_syllabus.pdf
```

### Examiner Reports
```
0580_igcse_mathematics_examiner_report_mj_2024.pdf
9709_as_mathematics_examiner_report_on_2023.pdf
0625_igcse_physics_examiner_report_mj_2024.pdf
```

### Pattern
```
{syllabus_code}_{level}_{subject}_{document_type}[_{session}_{year}].pdf
```

The ingestion script extracts:
- **Syllabus code** — first 4-digit block in filename (e.g. `0580`)
- **Level** — from folder name (`igcse`, `as`, `a2`) or filename token
- **Board** — from parent folder name (e.g. `cambridge`)
- **Subject** — from filename if it contains a known subject name
- **Document type** — from folder (`syllabi/` → syllabus, `examiner-reports/` → examiner_report)

---

## Running the Ingestion

```bash
npm run curriculum:ingest
```

Or directly:
```bash
npx tsx scripts/ingestCurriculumDocs.ts
```

This will:
1. Scan all subfolders recursively for `.pdf` files
2. Compute a SHA-256 fingerprint of each file
3. Skip any file already ingested (identified by hash — safe to re-run)
4. Extract text from each PDF
5. Split into retrieval chunks (~900 characters each)
6. Store the document and chunks in the database with full metadata
7. Print a summary showing ingested / skipped / failed counts

---

## What Happens With Unreadable PDFs

If a PDF is image-only (scanned) or contains insufficient text (fewer than 50 words extracted), the script will:
- Log it as **failed** with a clear reason
- Skip it and continue processing the rest of the batch
- Report it in the final summary

The batch does **not** abort on a single failure.

---

## Duplicate Handling

The ingestion script is **idempotent**: you can run it multiple times safely.

Duplicate detection uses a **SHA-256 hash** of the file contents. If a file with the same hash already exists in the database, it is skipped with a "Already ingested" message.

This means:
- Re-running after adding new files only processes the new files
- Renaming a file does not cause re-ingestion (same content = same hash)
- Updating file contents causes a fresh ingest (different hash = new entry)

---

## Document Types and Their Use

| Type | Folder | Use in Copilot |
|------|--------|---------------|
| `syllabus` | `syllabi/` | Curriculum grounding — what topics must be covered |
| `examiner_report` | `examiner-reports/` | Common student errors, exam style insights |

These are stored separately and retrievable by type, so the AI copilot can query them distinctly.

---

## Metadata Stored Per Document

| Field | Source |
|-------|--------|
| `board` | Parent folder name (e.g. `Cambridge`) |
| `level` | Sub-folder or filename token (`IGCSE`, `AS`, `A2`) |
| `syllabusCode` | First 4-digit block in filename, or filename slug |
| `subject` | Matched against known subject names in filename |
| `documentType` | `syllabus` or `examiner_report` based on folder |
| `filename` | Original filename |
| `originalPath` | Relative path from project root |
| `contentHash` | SHA-256 of file bytes (used for dedup) |
| `extractedText` | Full parsed text |
| Chunks | ~900-character chunks for retrieval |
