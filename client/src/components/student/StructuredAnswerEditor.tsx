import { useCallback, useEffect, useRef } from "react";
import DOMPurify from "dompurify";
import { getAuthHeaders } from "@/lib/supabase";
import { Bold, Italic, Underline, List } from "lucide-react";

// ── Structured / written-answer editor ──────────────────────────────────────
// A deliberately minimal "exam paper" the student types into:
//   • white box with very faint grey rules (lined-paper feel)
//   • bullet points (no numbering), bold / italic / underline only
//   • flag-only UK-English spell check — misspellings get a faint underline,
//     no popover and no auto-correction (per product decision)
// The value is stored as sanitised-ish HTML so bullets/formatting round-trip.

const LINE_HEIGHT = 28; // px — must match the lined-paper gradient spacing

// Class applied to flagged words. Defined here so the decorate/undecorate
// passes can find and strip them reliably.
const MISSPELL_CLASS = "soma-misspell";

interface Props {
  value: string;
  onChange: (html: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

/** Absolute caret offset (in characters) within an element, or null. */
function getCaretOffset(root: HTMLElement): number | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;
  const pre = range.cloneRange();
  pre.selectNodeContents(root);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

/** Restore the caret to an absolute character offset within an element. */
function setCaretOffset(root: HTMLElement, offset: number) {
  const sel = window.getSelection();
  if (!sel) return;
  let remaining = offset;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null = walker.nextNode();
  while (node) {
    const len = node.textContent?.length ?? 0;
    if (remaining <= len) {
      const range = document.createRange();
      range.setStart(node, Math.max(0, Math.min(remaining, len)));
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    remaining -= len;
    node = walker.nextNode();
  }
}

/** Remove all spell-flag spans, merging their text back into the document. */
function stripMisspellSpans(root: HTMLElement) {
  const spans = Array.from(root.querySelectorAll(`span.${MISSPELL_CLASS}`));
  for (const span of spans) {
    const text = document.createTextNode(span.textContent ?? "");
    span.replaceWith(text);
  }
  root.normalize();
}

/** Wrap each occurrence of a flagged word in a faint-underline span. */
function decorateMisspellings(root: HTMLElement, words: Set<string>) {
  if (words.size === 0) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let n: Node | null = walker.nextNode();
  while (n) {
    textNodes.push(n as Text);
    n = walker.nextNode();
  }
  for (const textNode of textNodes) {
    const content = textNode.textContent ?? "";
    if (!content.trim()) continue;
    // Split on word boundaries, keeping separators so we can rebuild verbatim.
    // ASCII word chars only (no \p{L}/u flag) to stay compatible with the
    // project's TS target; fine for UK-English light flagging.
    const parts = content.split(/(\b[A-Za-z']+\b)/);
    if (!parts.some((p) => words.has(p.toLowerCase()))) continue;
    const frag = document.createDocumentFragment();
    for (const part of parts) {
      if (part && words.has(part.toLowerCase())) {
        const span = document.createElement("span");
        span.className = MISSPELL_CLASS;
        span.textContent = part;
        frag.appendChild(span);
      } else if (part) {
        frag.appendChild(document.createTextNode(part));
      }
    }
    textNode.replaceWith(frag);
  }
}

export default function StructuredAnswerEditor({ value, onChange, disabled, placeholder }: Props) {
  const editorRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const spellAbortRef = useRef<AbortController | null>(null);

  // Seed the editor once from `value`. The editor is otherwise uncontrolled so
  // typing / formatting doesn't fight React re-renders or move the caret.
  useEffect(() => {
    const el = editorRef.current;
    if (el && el.innerHTML !== value) {
      // Sanitise the seeded answer — it's the student's own saved HTML, but we
      // never assign untrusted markup straight into innerHTML.
      el.innerHTML = DOMPurify.sanitize(value || "", {
        ALLOWED_TAGS: ["b", "strong", "i", "em", "u", "ul", "li", "br", "div", "p", "span"],
        ALLOWED_ATTR: [],
      });
    }
    // Intentionally run only on mount — see comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const emitChange = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    // Strip flag spans from the persisted value — they're decoration only.
    const clone = el.cloneNode(true) as HTMLElement;
    stripMisspellSpans(clone);
    onChange(clone.innerHTML);
  }, [onChange]);

  const runSpellCheck = useCallback(async () => {
    const el = editorRef.current;
    if (!el) return;
    const text = el.textContent ?? "";
    if (text.trim().length < 2) {
      stripMisspellSpans(el);
      return;
    }
    spellAbortRef.current?.abort();
    const controller = new AbortController();
    spellAbortRef.current = controller;
    try {
      // /api/soma/spellcheck is behind requireSupabaseAuth, which needs the
      // Bearer token — bare fetch + credentials:"include" would 401. We keep a
      // raw fetch (rather than authFetch) so the AbortController still cancels
      // stale in-flight scans while the student keeps typing.
      const authHeaders = await getAuthHeaders();
      const res = await fetch("/api/soma/spellcheck", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: controller.signal,
        credentials: "include",
      });
      if (!res.ok) return;
      const data = await res.json();
      const words = new Set<string>(
        Array.isArray(data?.misspelled)
          ? data.misspelled.map((w: unknown) => String(w).toLowerCase()).filter(Boolean)
          : [],
      );
      const caret = getCaretOffset(el);
      stripMisspellSpans(el);
      decorateMisspellings(el, words);
      if (caret != null) setCaretOffset(el, caret);
    } catch {
      // Network/abort — spell check is best-effort and never blocks the student.
    }
  }, []);

  const handleInput = useCallback(() => {
    emitChange();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // Light, idle-triggered scan so we don't hammer the AI on every keystroke.
    debounceRef.current = setTimeout(() => { void runSpellCheck(); }, 1200);
  }, [emitChange, runSpellCheck]);

  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    spellAbortRef.current?.abort();
  }, []);

  const exec = (command: string) => {
    if (disabled) return;
    editorRef.current?.focus();
    // execCommand is deprecated but remains the simplest cross-browser way to
    // toggle inline formatting / bullets inside a contentEditable.
    document.execCommand(command, false);
    emitChange();
  };

  const ToolbarButton = ({ icon: Icon, command, label }: { icon: typeof Bold; command: string; label: string }) => (
    <button
      type="button"
      onMouseDown={(e) => { e.preventDefault(); exec(command); }}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="h-8 w-8 flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted/70 disabled:opacity-40"
      data-testid={`structured-format-${command}`}
    >
      <Icon className="w-4 h-4" />
    </button>
  );

  return (
    <div className="rounded-xl overflow-hidden border border-border bg-card shadow-sm" data-testid="structured-answer-editor">
      {/* Minimal formatting toolbar */}
      <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-border bg-muted">
        <ToolbarButton icon={Bold} command="bold" label="Bold" />
        <ToolbarButton icon={Italic} command="italic" label="Italic" />
        <ToolbarButton icon={Underline} command="underline" label="Underline" />
        <span className="w-px h-5 bg-muted mx-1" />
        <ToolbarButton icon={List} command="insertUnorderedList" label="Bullet list" />
        <span className="ml-auto text-[10px] uppercase tracking-wider text-muted-foreground">UK English</span>
      </div>

      {/* Lined "paper" editing surface */}
      <div
        ref={editorRef}
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Your answer"
        data-placeholder={placeholder ?? ""}
        onInput={handleInput}
        onBlur={emitChange}
        spellCheck={false}
        className="soma-structured-surface px-4 py-3 min-h-[180px] text-foreground text-[15px] focus:outline-none"
        style={{
          lineHeight: `${LINE_HEIGHT}px`,
          backgroundImage:
            "repeating-linear-gradient(to bottom, transparent, transparent " +
            `${LINE_HEIGHT - 1}px, rgba(148,163,184,0.35) ${LINE_HEIGHT - 1}px, rgba(148,163,184,0.35) ${LINE_HEIGHT}px)`,
          // Anchor the ruled lines to the content box so each line of text rests
          // on a rule (rather than starting from the padding edge, which left
          // the text floating between lines).
          backgroundOrigin: "content-box",
          backgroundClip: "content-box",
        }}
        data-testid="structured-answer-surface"
      />
    </div>
  );
}
