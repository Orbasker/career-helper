import { BorderStyle, Document, Packer, Paragraph, TextRun, type IParagraphOptions, type IRunOptions } from "docx";
import { cvBlocks, type CvBlock, type CvBlockStyle, type CvDocumentContent } from "./document.js";

const FONT = "Arial";
const BODY_SIZE = 21;
const ACCENT = "1F3864";
const MUTED = "595959";

const STYLES: Record<CvBlockStyle, { run: IRunOptions; paragraph: IParagraphOptions }> = {
  name: { run: { bold: true, size: 36, color: ACCENT }, paragraph: { spacing: { after: 40 } } },
  headline: { run: { size: 24, color: MUTED }, paragraph: {} },
  contact: { run: { size: 19, color: MUTED }, paragraph: {} },
  heading: {
    run: { bold: true, size: 24, color: ACCENT },
    paragraph: { spacing: { before: 240, after: 100 }, border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: ACCENT, space: 2 } } },
  },
  text: { run: {}, paragraph: {} },
  role: { run: { bold: true }, paragraph: { spacing: { before: 120, after: 0 } } },
  period: { run: { italics: true, color: MUTED, size: 19 }, paragraph: {} },
  bullet: { run: {}, paragraph: { bullet: { level: 0 }, spacing: { after: 40 } } },
};

/** Renders the CV with one fixed template; the same content always produces the same document. */
export async function renderCvDocx(content: CvDocumentContent): Promise<Uint8Array> {
  const document = new Document({
    creator: "Career Agent",
    title: content.name,
    styles: { default: { document: { run: { font: FONT, size: BODY_SIZE } } } },
    sections: [{ properties: { page: { margin: { top: 900, bottom: 900, left: 1000, right: 1000 } } }, children: cvBlocks(content).map(paragraph) }],
  });
  return new Uint8Array(await Packer.toBuffer(document));
}

function paragraph(block: CvBlock): Paragraph {
  const style = STYLES[block.style];
  return new Paragraph({
    ...(block.rtl ? { bidirectional: true } : {}),
    spacing: { after: 60 },
    ...style.paragraph,
    ...(block.keepWithNext ? { keepNext: true } : {}),
    children: [new TextRun({ text: block.text, font: FONT, size: BODY_SIZE, ...style.run, ...(block.rtlRun ? { rightToLeft: true } : {}) })],
  });
}
