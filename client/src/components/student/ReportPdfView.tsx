import { forwardRef, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import DOMPurify from "dompurify";
import { normalizeLatexDelimiters } from "@/components/MarkdownRenderer";

// Print-friendly report view. Rendered hidden off-screen and passed to
// html2pdf.js as the rasterisation source. Uses inline styles (not Tailwind)
// so the PDF output is stable regardless of the app's dark theme and custom
// CSS variables. The 700px width matches A4 usable area at 96 DPI with 12mm
// margins, so the rasteriser does not have to scale the layout.
//
// Question stems, options and explanations are rendered through ReactMarkdown
// with remark-math + rehype-katex so that LaTeX (e.g. $\frac{1}{2}$, matrices,
// integrals) appears as real mathematical notation in the PDF, not literal
// dollar signs. KaTeX CSS is imported globally in client/src/index.css so the
// .katex output picks up the correct glyphs when html2canvas rasterises it.

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

const LOGO_URL = "/MCEC Transparent Logo.jpg";

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

const FONT_SERIF = "Georgia, 'Times New Roman', serif";
const FONT_SANS = "Helvetica, Arial, sans-serif";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#d4d4d4";

// ReactMarkdown passes loosely-typed props (node trees from rehype/remark) so
// we declare the minimal shape we actually read. Kept local to this file
// because the overrides force a print-friendly palette that has no reuse.
type MdProps = { children?: ReactNode };
type MdLinkProps = MdProps & { href?: string };

// ReactMarkdown component overrides that force a light palette. Defined at
// module scope so they are referentially stable across renders.
const MD_COMPONENTS = {
  p: ({ children }: MdProps) => (
    <p style={{ margin: "0 0 6px 0", lineHeight: 1.55 }}>{children}</p>
  ),
  strong: ({ children }: MdProps) => (
    <strong style={{ fontWeight: 700, color: INK }}>{children}</strong>
  ),
  em: ({ children }: MdProps) => <em style={{ fontStyle: "italic" }}>{children}</em>,
  code: ({ children }: MdProps) => (
    <code
      style={{
        fontFamily: "Menlo, Consolas, monospace",
        background: "#f1f5f9",
        color: "#334155",
        padding: "1px 4px",
        borderRadius: "3px",
        fontSize: "0.9em",
      }}
    >
      {children}
    </code>
  ),
  pre: ({ children }: MdProps) => (
    <pre
      style={{
        fontFamily: "Menlo, Consolas, monospace",
        background: "#f1f5f9",
        color: "#1e293b",
        padding: "8px 10px",
        borderRadius: "4px",
        fontSize: "11px",
        overflow: "hidden",
        whiteSpace: "pre-wrap",
      }}
    >
      {children}
    </pre>
  ),
  ul: ({ children }: MdProps) => (
    <ul style={{ margin: "4px 0 6px 18px", padding: 0 }}>{children}</ul>
  ),
  ol: ({ children }: MdProps) => (
    <ol style={{ margin: "4px 0 6px 18px", padding: 0 }}>{children}</ol>
  ),
  li: ({ children }: MdProps) => <li style={{ margin: "2px 0" }}>{children}</li>,
  blockquote: ({ children }: MdProps) => (
    <blockquote
      style={{
        borderLeft: "3px solid " + RULE,
        margin: "6px 0",
        padding: "2px 10px",
        color: "#4a4a4a",
        fontStyle: "italic",
      }}
    >
      {children}
    </blockquote>
  ),
  table: ({ children }: MdProps) => (
    <table
      style={{
        borderCollapse: "collapse",
        margin: "6px 0",
        width: "100%",
        fontSize: "11.5px",
      }}
    >
      {children}
    </table>
  ),
  th: ({ children }: MdProps) => (
    <th style={{ border: "1px solid " + RULE, padding: "4px 6px", textAlign: "left", background: "#f8fafc" }}>
      {children}
    </th>
  ),
  td: ({ children }: MdProps) => (
    <td style={{ border: "1px solid " + RULE, padding: "4px 6px" }}>{children}</td>
  ),
  a: ({ children, href }: MdLinkProps) => (
    <a href={href} style={{ color: "#1d4ed8", textDecoration: "underline" }}>
      {children}
    </a>
  ),
};

function Md({ content }: { content: string }) {
  if (!content) return null;
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={MD_COMPONENTS}
    >
      {normalizeLatexDelimiters(content)}
    </ReactMarkdown>
  );
}

const S = {
  page: {
    fontFamily: FONT_SERIF,
    color: INK,
    background: "#ffffff",
    padding: "28px 32px",
    width: "700px",
    boxSizing: "border-box" as const,
    lineHeight: 1.5,
  },
  topBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "16px",
  },
  logoImg: {
    height: "44px",
    width: "auto",
    objectFit: "contain" as const,
    display: "block",
  },
  brandRight: {
    textAlign: "right" as const,
    fontFamily: FONT_SANS,
    fontSize: "10px",
    letterSpacing: "0.18em",
    textTransform: "uppercase" as const,
    color: MUTED,
    lineHeight: 1.4,
  },
  header: {
    borderTop: "2px solid " + INK,
    borderBottom: "1px solid " + RULE,
    padding: "14px 0 16px 0",
    marginBottom: "20px",
  },
  eyebrow: {
    fontSize: "10px",
    letterSpacing: "0.2em",
    textTransform: "uppercase" as const,
    color: MUTED,
    fontFamily: FONT_SANS,
  },
  title: {
    fontSize: "22px",
    fontWeight: 700,
    margin: "6px 0 6px 0",
    lineHeight: 1.2,
  },
  meta: {
    fontSize: "12px",
    color: "#4a4a4a",
    fontFamily: FONT_SANS,
  },
  metaLine: {
    margin: "2px 0",
  },
  scoreRow: {
    display: "flex",
    gap: "10px",
    marginTop: "16px",
  },
  scoreCell: {
    flex: 1,
    border: "1px solid " + RULE,
    padding: "10px 12px",
    textAlign: "center" as const,
  },
  scoreNum: {
    fontSize: "20px",
    fontWeight: 700,
    lineHeight: 1.1,
  },
  scoreLabel: {
    fontSize: "10px",
    textTransform: "uppercase" as const,
    letterSpacing: "0.1em",
    color: MUTED,
    marginTop: "4px",
    fontFamily: FONT_SANS,
  },
  sectionHeading: {
    fontSize: "12px",
    textTransform: "uppercase" as const,
    letterSpacing: "0.14em",
    color: MUTED,
    fontFamily: FONT_SANS,
    marginTop: "22px",
    marginBottom: "10px",
    borderBottom: "1px solid " + RULE,
    paddingBottom: "4px",
  },
  aiBox: {
    border: "1px solid #cbd5e1",
    background: "#f8fafc",
    padding: "14px 16px",
    fontSize: "12.5px",
    lineHeight: 1.6,
    breakInside: "avoid" as const,
    pageBreakInside: "avoid" as const,
  },
  question: {
    breakInside: "avoid" as const,
    pageBreakInside: "avoid" as const,
    border: "1px solid " + RULE,
    padding: "14px 16px",
    marginTop: "12px",
  },
  qHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "8px",
    fontFamily: FONT_SANS,
  },
  qNum: {
    fontSize: "11px",
    letterSpacing: "0.1em",
    textTransform: "uppercase" as const,
    color: MUTED,
    fontWeight: 600,
  },
  qVerdict: {
    fontSize: "10px",
    fontWeight: 700,
    padding: "3px 10px",
    border: "1px solid",
    borderRadius: "3px",
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
  },
  qStem: {
    fontSize: "13px",
    marginBottom: "10px",
    lineHeight: 1.55,
  },
  optionList: {
    listStyle: "none",
    padding: 0,
    margin: "0 0 10px 0",
  },
  optionRow: {
    fontSize: "12px",
    padding: "7px 10px",
    borderLeft: "3px solid #e4e4e4",
    marginBottom: "4px",
    fontFamily: FONT_SANS,
    lineHeight: 1.5,
  },
  optionTag: {
    color: MUTED,
    fontSize: "10px",
    marginLeft: "8px",
    fontStyle: "italic" as const,
  },
  explanation: {
    fontSize: "12px",
    background: "#fafafa",
    borderLeft: "3px solid #9ca3af",
    padding: "10px 12px",
    marginTop: "10px",
    lineHeight: 1.6,
  },
  explLabel: {
    fontSize: "10px",
    fontWeight: 700,
    textTransform: "uppercase" as const,
    letterSpacing: "0.12em",
    color: MUTED,
    marginBottom: "4px",
    fontFamily: FONT_SANS,
  },
  footer: {
    marginTop: "28px",
    paddingTop: "10px",
    borderTop: "1px solid " + RULE,
    fontSize: "10px",
    color: "#8a8a8a",
    fontFamily: FONT_SANS,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
};

const ReportPdfView = forwardRef<HTMLDivElement, { data: ReportPdfData }>(
  function ReportPdfView({ data }, ref) {
    const pct = data.totalMarks > 0 ? Math.round((data.score / data.totalMarks) * 100) : 0;
    const metaBits = [data.subject, data.level, data.syllabus].filter(Boolean);

    return (
      <div ref={ref} style={S.page}>
        <div style={S.topBar}>
          <img
            src={LOGO_URL}
            alt="MelaniCalvin Education Centre"
            style={S.logoImg}
            crossOrigin="anonymous"
          />
          <div style={S.brandRight}>
            <div>MelaniCalvin Education Centre</div>
            <div style={{ opacity: 0.75 }}>soma · assessment report</div>
          </div>
        </div>

        <div style={S.header}>
          <div style={S.eyebrow}>Assessment report</div>
          <h1 style={S.title}>{data.title}</h1>
          <div style={S.meta}>
            {metaBits.length > 0 && <div style={S.metaLine}>{metaBits.join(" · ")}</div>}
            <div style={S.metaLine}>
              <strong>Student:</strong> {data.studentName}
            </div>
            {data.completedAt && (
              <div style={S.metaLine}>
                <strong>Completed:</strong> {formatDate(data.completedAt)}
              </div>
            )}
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
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(data.aiFeedbackHtml) }}
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

              <div style={S.qStem}><Md content={q.stem} /></div>

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
                      <span style={{ display: "flex", alignItems: "baseline", gap: "6px" }}>
                        <strong>{letter}.</strong>
                        <span style={{ flex: 1 }}><Md content={option} /></span>
                        {tags.length > 0 && (
                          <span style={S.optionTag}>({tags.join(", ")})</span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>

              {q.explanation && (
                <div style={S.explanation}>
                  <div style={S.explLabel}>soma explanation</div>
                  <Md content={q.explanation} />
                </div>
              )}
            </div>
          );
        })}

        <div style={S.footer}>
          <span>Prepared by MelaniCalvin Education Centre · soma</span>
          <span>{formatDate(new Date().toISOString())}</span>
        </div>
      </div>
    );
  },
);

export default ReportPdfView;
