import { forwardRef } from "react";

// Print-friendly report view. Rendered hidden off-screen and passed to
// html2pdf.js as the rasterisation source. Uses inline styles (not Tailwind)
// so the PDF output is stable regardless of the app's dark theme and custom
// CSS variables. The layout is deliberately plain: white background, black
// text, simple rules — optimised for printing and reading at A4.

export interface ReportPdfQuestion {
  id: number;
  stem: string;
  options: string[];
  correctAnswer: string;
  marks: number;
  explanation: string | null;
}

export interface ReportPdfData {
  title: string;
  subject: string | null;
  level: string | null;
  syllabus: string | null;
  studentName: string;
  score: number;
  totalMarks: number;
  completedAt: string | null;
  aiFeedbackHtml: string | null;
  questions: ReportPdfQuestion[];
  answers: Record<string, string>;
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

const S = {
  page: {
    fontFamily: "Georgia, 'Times New Roman', serif",
    color: "#1a1a1a",
    background: "#ffffff",
    padding: "24px",
    width: "780px",
    boxSizing: "border-box" as const,
    lineHeight: 1.5,
  },
  header: {
    borderBottom: "2px solid #1a1a1a",
    paddingBottom: "14px",
    marginBottom: "18px",
  },
  brand: {
    fontSize: "11px",
    letterSpacing: "0.18em",
    textTransform: "uppercase" as const,
    color: "#6b6b6b",
    fontFamily: "Helvetica, Arial, sans-serif",
  },
  title: {
    fontSize: "22px",
    fontWeight: 700,
    margin: "6px 0 4px 0",
  },
  meta: {
    fontSize: "12px",
    color: "#4a4a4a",
    fontFamily: "Helvetica, Arial, sans-serif",
  },
  scoreRow: {
    display: "flex",
    gap: "12px",
    marginTop: "14px",
  },
  scoreCell: {
    flex: 1,
    border: "1px solid #d4d4d4",
    padding: "10px 12px",
    textAlign: "center" as const,
  },
  scoreNum: {
    fontSize: "18px",
    fontWeight: 700,
  },
  scoreLabel: {
    fontSize: "10px",
    textTransform: "uppercase" as const,
    letterSpacing: "0.1em",
    color: "#6b6b6b",
    marginTop: "2px",
    fontFamily: "Helvetica, Arial, sans-serif",
  },
  sectionHeading: {
    fontSize: "13px",
    textTransform: "uppercase" as const,
    letterSpacing: "0.12em",
    color: "#6b6b6b",
    fontFamily: "Helvetica, Arial, sans-serif",
    marginTop: "22px",
    marginBottom: "8px",
    borderBottom: "1px solid #d4d4d4",
    paddingBottom: "4px",
  },
  aiBox: {
    border: "1px solid #cbd5e1",
    background: "#f8fafc",
    padding: "14px 16px",
    fontSize: "12.5px",
    lineHeight: 1.6,
  },
  question: {
    breakInside: "avoid" as const,
    pageBreakInside: "avoid" as const,
    border: "1px solid #d4d4d4",
    padding: "14px 16px",
    marginTop: "12px",
  },
  qHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginBottom: "8px",
    fontFamily: "Helvetica, Arial, sans-serif",
  },
  qNum: {
    fontSize: "11px",
    letterSpacing: "0.1em",
    textTransform: "uppercase" as const,
    color: "#6b6b6b",
    fontWeight: 600,
  },
  qVerdict: {
    fontSize: "11px",
    fontWeight: 700,
    padding: "2px 8px",
    border: "1px solid",
    borderRadius: "3px",
  },
  qStem: {
    fontSize: "13px",
    marginBottom: "10px",
  },
  optionList: {
    listStyle: "none",
    padding: 0,
    margin: "0 0 10px 0",
  },
  optionRow: {
    fontSize: "12px",
    padding: "6px 8px",
    borderLeft: "3px solid #e4e4e4",
    marginBottom: "3px",
    fontFamily: "Helvetica, Arial, sans-serif",
  },
  explanation: {
    fontSize: "12px",
    background: "#fafafa",
    borderLeft: "3px solid #9ca3af",
    padding: "8px 12px",
    marginTop: "8px",
    lineHeight: 1.55,
  },
  explLabel: {
    fontSize: "10px",
    fontWeight: 700,
    textTransform: "uppercase" as const,
    letterSpacing: "0.1em",
    color: "#6b6b6b",
    marginBottom: "4px",
    fontFamily: "Helvetica, Arial, sans-serif",
  },
  footer: {
    marginTop: "24px",
    paddingTop: "10px",
    borderTop: "1px solid #d4d4d4",
    fontSize: "10px",
    color: "#8a8a8a",
    textAlign: "center" as const,
    fontFamily: "Helvetica, Arial, sans-serif",
  },
};

const ReportPdfView = forwardRef<HTMLDivElement, { data: ReportPdfData }>(
  function ReportPdfView({ data }, ref) {
    const pct = data.totalMarks > 0 ? Math.round((data.score / data.totalMarks) * 100) : 0;
    const metaBits = [data.subject, data.level, data.syllabus].filter(Boolean);

    return (
      <div ref={ref} style={S.page}>
        <div style={S.header}>
          <div style={S.brand}>soma · assessment report</div>
          <h1 style={S.title}>{data.title}</h1>
          <div style={S.meta}>
            {metaBits.length > 0 && <div>{metaBits.join(" · ")}</div>}
            <div>
              <strong>Student:</strong> {data.studentName}
              {data.completedAt && (
                <>
                  {"  ·  "}
                  <strong>Completed:</strong> {formatDate(data.completedAt)}
                </>
              )}
            </div>
          </div>

          <div style={S.scoreRow}>
            <div style={S.scoreCell}>
              <div style={S.scoreNum}>{pct}%</div>
              <div style={S.scoreLabel}>Score</div>
            </div>
            <div style={S.scoreCell}>
              <div style={S.scoreNum}>{data.score} / {data.totalMarks}</div>
              <div style={S.scoreLabel}>Marks</div>
            </div>
            <div style={S.scoreCell}>
              <div style={S.scoreNum}>{data.questions.length}</div>
              <div style={S.scoreLabel}>Questions</div>
            </div>
          </div>
        </div>

        {data.aiFeedbackHtml && (
          <>
            <div style={S.sectionHeading}>soma feedback</div>
            <div
              style={S.aiBox}
              dangerouslySetInnerHTML={{ __html: data.aiFeedbackHtml }}
            />
          </>
        )}

        <div style={S.sectionHeading}>Question review</div>
        {data.questions.map((q, idx) => {
          const studentAnswer = data.answers[String(q.id)] || null;
          const isCorrect = studentAnswer === q.correctAnswer;
          const verdictText = isCorrect ? "Correct" : studentAnswer ? "Incorrect" : "Skipped";
          const verdictColor = isCorrect ? "#166534" : studentAnswer ? "#991b1b" : "#4b5563";

          return (
            <div key={q.id} style={S.question}>
              <div style={S.qHeader}>
                <span style={S.qNum}>Question {idx + 1} · {q.marks} mark{q.marks === 1 ? "" : "s"}</span>
                <span style={{ ...S.qVerdict, color: verdictColor, borderColor: verdictColor }}>
                  {verdictText}
                </span>
              </div>

              <div style={S.qStem}>{stripHtml(q.stem)}</div>

              <ul style={S.optionList}>
                {q.options.map((option, optIdx) => {
                  const letter = String.fromCharCode(65 + optIdx);
                  const isCorrectOption = option === q.correctAnswer;
                  const isStudentPick = option === studentAnswer;

                  let borderColor = "#e4e4e4";
                  let background = "#ffffff";
                  let weight = 400;
                  const tags: string[] = [];

                  if (isCorrectOption) {
                    borderColor = "#166534";
                    background = "#f0fdf4";
                    weight = 600;
                    tags.push("correct answer");
                  }
                  if (isStudentPick) {
                    tags.push("student answer");
                    if (!isCorrectOption) {
                      borderColor = "#991b1b";
                      background = "#fef2f2";
                    }
                  }

                  return (
                    <li
                      key={optIdx}
                      style={{
                        ...S.optionRow,
                        borderLeftColor: borderColor,
                        background,
                        fontWeight: weight,
                      }}
                    >
                      <strong>{letter}.</strong> {stripHtml(option)}
                      {tags.length > 0 && (
                        <span style={{ color: "#6b6b6b", fontSize: "10px", marginLeft: "6px" }}>
                          ({tags.join(", ")})
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>

              {q.explanation && (
                <div style={S.explanation}>
                  <div style={S.explLabel}>soma explanation</div>
                  {stripHtml(q.explanation)}
                </div>
              )}
            </div>
          );
        })}

        <div style={S.footer}>
          Generated by soma · {formatDate(new Date().toISOString())}
        </div>
      </div>
    );
  },
);

export default ReportPdfView;
