import { readFile } from "node:fs/promises";
import fontkit from "@pdf-lib/fontkit";
import bidiModule, { type Bidi } from "bidi-js";
import { PDFDocument, rgb, type PDFFont } from "pdf-lib";
import { cvBlocks, type CvBlock, type CvBlockStyle, type CvDocumentContent } from "./document.js";

type FontKind = "regular" | "bold" | "italic";

const FONT_FILES: Record<FontKind, string> = { regular: "Arimo-Regular.ttf", bold: "Arimo-Bold.ttf", italic: "Arimo-Italic.ttf" };
const FONT_DIR = new URL("../../assets/fonts/", import.meta.url);

export const PAGE = { width: 595.28, height: 841.89, top: 45, bottom: 45, left: 50, right: 50 };
const ACCENT = rgb(0x1f / 255, 0x38 / 255, 0x64 / 255);
const MUTED = rgb(0x59 / 255, 0x59 / 255, 0x59 / 255);
const BLACK = rgb(0, 0, 0);
const BULLET_INDENT = 14;

interface PdfStyle {
  font: FontKind;
  size: number;
  color: typeof BLACK;
  before: number;
  after: number;
}

const STYLES: Record<CvBlockStyle, PdfStyle> = {
  name: { font: "bold", size: 18, color: ACCENT, before: 0, after: 2 },
  headline: { font: "regular", size: 12, color: MUTED, before: 0, after: 3 },
  contact: { font: "regular", size: 9.5, color: MUTED, before: 0, after: 3 },
  heading: { font: "bold", size: 12, color: ACCENT, before: 12, after: 5 },
  text: { font: "regular", size: 10.5, color: BLACK, before: 0, after: 3 },
  role: { font: "bold", size: 10.5, color: BLACK, before: 6, after: 0 },
  period: { font: "italic", size: 9.5, color: MUTED, before: 0, after: 3 },
  bullet: { font: "regular", size: 10.5, color: BLACK, before: 0, after: 2 },
};

/** A line placed on a page, its text already in visual (left-to-right drawing) order. */
export interface PdfLine {
  page: number;
  x: number;
  y: number;
  width: number;
  text: string;
  style: CvBlockStyle;
  bullet: { x: number } | null;
  rule: boolean;
}

const BIDI_CONTROLS = /[‎‏‪-‮⁦-⁩]/g;
const bidiFactory = ((bidiModule as { default?: unknown }).default ?? bidiModule) as () => Bidi;
const bidi = bidiFactory();
let fontBytes: Promise<Record<FontKind, Uint8Array>> | undefined;

function loadFontBytes(): Promise<Record<FontKind, Uint8Array>> {
  fontBytes ??= Promise.all(
    (Object.keys(FONT_FILES) as FontKind[]).map(async (kind) => [kind, await readFile(new URL(FONT_FILES[kind], FONT_DIR))] as const),
  ).then((entries) => Object.fromEntries(entries) as unknown as Record<FontKind, Uint8Array>);
  return fontBytes;
}

async function createDocument(content: CvDocumentContent) {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.registerFontkit(fontkit);
  pdf.setTitle(content.name);
  pdf.setCreator("Career Agent");
  pdf.setProducer("Career Agent");
  pdf.setLanguage(content.language === "he" ? "he-IL" : "en-US");
  const bytes = await loadFontBytes();
  const fonts = {} as Record<FontKind, PDFFont>;
  for (const kind of Object.keys(FONT_FILES) as FontKind[]) fonts[kind] = await pdf.embedFont(bytes[kind], { subset: true });
  return { pdf, fonts };
}

/** Where every line of the CV goes in the PDF. */
export async function layoutCvPdf(content: CvDocumentContent): Promise<PdfLine[]> {
  const { fonts } = await createDocument(content);
  return placeLines(cvBlocks(content), fonts);
}

/** Wraps and places every block on A4 pages, mirroring the layout for right-to-left paragraphs. */
function placeLines(blocks: readonly CvBlock[], fonts: Record<FontKind, PDFFont>): PdfLine[] {
  const contentWidth = PAGE.width - PAGE.left - PAGE.right;
  const lineHeight = (style: PdfStyle) => style.size * 1.25;
  const wrapped = blocks.map((block) => {
    const style = STYLES[block.style];
    const indent = block.style === "bullet" ? BULLET_INDENT : 0;
    const font = fonts[style.font];
    const measure = (text: string) => font.widthOfTextAtSize(text.replace(BIDI_CONTROLS, ""), style.size);
    return { block, style, indent, measure, lines: visualLines(block, contentWidth - indent, measure) };
  });

  const lines: PdfLine[] = [];
  let page = 0;
  let y = PAGE.height - PAGE.top;
  for (const [i, { block, style, indent, measure, lines: texts }] of wrapped.entries()) {
    const next = wrapped[i + 1];
    const height = style.before + texts.length * lineHeight(style) + style.after;
    const keep = block.keepWithNext && next ? next.style.before + lineHeight(next.style) : 0;
    if (y - height - keep < PAGE.bottom && y < PAGE.height - PAGE.top) {
      page++;
      y = PAGE.height - PAGE.top;
    }
    y -= style.before;
    for (const [lineIndex, text] of texts.entries()) {
      if (y - lineHeight(style) < PAGE.bottom) {
        page++;
        y = PAGE.height - PAGE.top;
      }
      y -= lineHeight(style);
      const width = measure(text);
      const x = block.rtl ? PAGE.width - PAGE.right - indent - width : PAGE.left + indent;
      const bulletX = block.rtl ? PAGE.width - PAGE.right - BULLET_INDENT / 2 : PAGE.left + 2;
      lines.push({
        page,
        x,
        y,
        width,
        text,
        style: block.style,
        bullet: block.style === "bullet" && lineIndex === 0 ? { x: bulletX } : null,
        rule: block.style === "heading",
      });
    }
    y -= style.after;
  }
  return lines;
}

/** Renders the CV as a PDF from the same content and template as the DOCX, with the fonts embedded. */
export async function renderCvPdf(content: CvDocumentContent): Promise<Uint8Array> {
  const { pdf, fonts } = await createDocument(content);
  const lines = placeLines(cvBlocks(content), fonts);
  const pages = Array.from({ length: (lines.at(-1)?.page ?? 0) + 1 }, () => pdf.addPage([PAGE.width, PAGE.height]));
  for (const line of lines) {
    const page = pages[line.page]!;
    const style = STYLES[line.style];
    const font = fonts[style.font];
    let x = line.x;
    for (const run of drawingRuns(line.text)) {
      page.drawText(run.text, { x, y: line.y, size: style.size, font, color: style.color });
      x += font.widthOfTextAtSize(run.visual, style.size);
    }
    if (line.bullet) page.drawText("•", { x: line.bullet.x - 2, y: line.y, size: style.size, font: fonts.regular, color: BLACK });
    if (line.rule) {
      page.drawLine({
        start: { x: PAGE.left, y: line.y - 3 },
        end: { x: PAGE.width - PAGE.right, y: line.y - 3 },
        thickness: 0.75,
        color: ACCENT,
      });
    }
  }
  return pdf.save();
}

/** Breaks the block at spaces to fit `width`, then reorders each line for display with the Unicode bidi algorithm. */
function visualLines(block: CvBlock, width: number, measure: (text: string) => number): string[] {
  const { text } = block;
  const ranges: [number, number][] = [];
  let start = -1;
  let end = -1;
  for (const word of text.matchAll(/\S+/g)) {
    const wordEnd = word.index + word[0].length;
    if (start >= 0 && measure(text.slice(start, wordEnd)) > width) {
      ranges.push([start, end]);
      start = -1;
    }
    if (start < 0) start = word.index;
    end = wordEnd;
    while (measure(text.slice(start, end)) > width && end - start > 1) {
      let cut = end - 1;
      while (cut > start + 1 && measure(text.slice(start, cut)) > width) cut--;
      ranges.push([start, cut]);
      start = cut;
    }
  }
  if (start >= 0) ranges.push([start, end]);

  const levels = bidi.getEmbeddingLevels(text, block.rtl ? "rtl" : "ltr");
  return ranges.map(([start, end]) => bidi.getReorderedString(text, levels, start, end - 1).slice(start, end).replace(BIDI_CONTROLS, ""));
}

/** Splits a visual line into runs drawn left to right; fontkit reverses runs it detects as Hebrew, so those are passed in logical order. */
function drawingRuns(visual: string): { text: string; visual: string }[] {
  return (visual.match(/[֐-׿\s]*[֐-׿][֐-׿\s]*|[^֐-׿]+/g) ?? []).map((run) => ({
    text: /[֐-׿]/.test(run) ? [...run].reverse().join("") : run,
    visual: run,
  }));
}
