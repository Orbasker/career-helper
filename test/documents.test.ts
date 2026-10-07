import { Document, Packer, Paragraph, TextRun } from "docx";
import { describe, expect, it } from "vitest";
import { classifySource, detectDocumentLanguage, detectLanguage, documentFormat, parseDocument, parseLinkedinUrl } from "../src/app/documents.js";

const HEBREW_CV = ["דנה לוי", "מנהלת משאבי אנוש באקמה בעמ", "ניהלה צוות של שישה מגייסים"];
const ENGLISH_CV = ["Dana Levi", "HR Manager at Acme Ltd since 2019", "Managed a team of six recruiters"];
const isHebrew = (line: string) => /[א-ת]/.test(line);

/** Like real PDF writers, stores right-to-left lines in visual order and maps glyph codes back to Unicode with a ToUnicode CMap. */
function pdf(lines: string[]): Uint8Array {
  const chars = [...new Set(lines.join(""))];
  const hex = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();
  const code = (c: string) => hex(0x21 + chars.indexOf(c));
  const cmap = [
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
    "/CMapName /Adobe-Identity-UCS def /CMapType 2 def",
    "1 begincodespacerange <00> <FF> endcodespacerange",
    `${chars.length} beginbfchar`,
    ...chars.map((c) => `<${code(c)}> <${c.codePointAt(0)!.toString(16).padStart(4, "0").toUpperCase()}>`),
    "endbfchar endcmap CMapName currentdict /CMap defineresource pop end end",
  ].join("\n");
  const content = lines
    .map((line, i) => {
      const glyphs = isHebrew(line) ? [...line].reverse() : [...line];
      return `BT /F1 12 Tf 72 ${720 - i * 20} Td <${glyphs.map(code).join("")}> Tj ET`;
    })
    .join("\n");
  const length = (s: string) => new TextEncoder().encode(s).length;
  return new TextEncoder().encode(
    [
      "%PDF-1.4",
      "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
      "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
      "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj",
      `4 0 obj<</Length ${length(content)}>>stream\n${content}\nendstream endobj`,
      "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica/ToUnicode 6 0 R>>endobj",
      `6 0 obj<</Length ${length(cmap)}>>stream\n${cmap}\nendstream endobj`,
      "trailer<</Root 1 0 R>>",
      "%%EOF",
    ].join("\n"),
  );
}

async function docx(lines: string[]): Promise<Uint8Array> {
  const children = lines.map(
    (line) =>
      new Paragraph({
        bidirectional: isHebrew(line),
        children: [new TextRun({ text: line, rightToLeft: isHebrew(line) })],
      }),
  );
  return new Uint8Array(await Packer.toBuffer(new Document({ sections: [{ children }] })));
}

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const doc = (fileName: string, mimeType: string | null, data: Uint8Array) => ({ fileRef: "f", fileName, mimeType, data });

describe("documents", () => {
  it.each([
    ["Hebrew", HEBREW_CV, "he"],
    ["English", ENGLISH_CV, "en"],
  ] as const)("parses a %s CV from PDF and DOCX", async (_name, lines, language) => {
    expect(await parseDocument(doc("cv.pdf", "application/pdf", pdf(lines)))).toEqual({
      status: "parsed",
      format: "pdf",
      text: lines.join("\n"),
      language,
      languageCertain: true,
    });
    expect(await parseDocument(doc("cv.docx", DOCX_MIME, await docx(lines)))).toEqual({
      status: "parsed",
      format: "docx",
      text: lines.join("\n\n"),
      language,
      languageCertain: true,
    });
  });

  it("parses plain text", async () => {
    const text = ENGLISH_CV.join("\n");
    expect(await parseDocument(doc("cv.txt", null, new TextEncoder().encode(`  ${text}  \n`)))).toEqual({
      status: "parsed",
      format: "txt",
      text,
      language: "en",
      languageCertain: true,
    });
  });

  it("rejects legacy Word files, by extension, MIME type or file signature", async () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    for (const file of [doc("cv.doc", null, ole), doc("cv", "application/msword", ole), doc("cv.bin", null, ole)]) {
      expect(await parseDocument(file)).toMatchObject({ status: "unsupported", format: "doc" });
    }
  });

  it("reports unsupported, broken and near-empty files", async () => {
    expect(await parseDocument(doc("photo.jpg", "image/jpeg", new Uint8Array([1, 2])))).toMatchObject({
      status: "unsupported",
      format: "other",
    });
    expect(await parseDocument(doc("cv.txt", "text/plain", new TextEncoder().encode("hi")))).toEqual({
      status: "failed",
      format: "txt",
      error: "no readable text",
    });
    expect(await parseDocument(doc("cv.docx", DOCX_MIME, new Uint8Array([1, 2, 3])))).toMatchObject({
      status: "failed",
      format: "docx",
    });
  });

  it("prefers the MIME type and falls back to the file extension for the format", () => {
    const empty = new Uint8Array();
    expect(documentFormat({ fileName: "cv", mimeType: "application/pdf", data: empty })).toBe("pdf");
    expect(documentFormat({ fileName: "CV.DOCX", mimeType: null, data: empty })).toBe("docx");
    expect(documentFormat({ fileName: "notes.md", mimeType: null, data: empty })).toBe("txt");
    expect(documentFormat({ fileName: null, mimeType: "image/png", data: empty })).toBe("other");
  });

  it.each([
    ["דנה לוי, מנהלת משאבי אנוש ב-Acme, ניסיון עם Workday ו-SAP SuccessFactors", "he"],
    ["Dana Levi, HR Manager at Acme", "en"],
    ["Dana Levi — דנה לוי — HR Manager, Acme Ltd, Tel Aviv, Workday, SAP SuccessFactors, Greenhouse", "en"],
    ["2019 – 2024", null],
  ])("detects the language of %s", (text, language) => {
    expect(detectLanguage(text)).toBe(language);
  });

  it.each([
    ["דנה לוי, מנהלת משאבי אנוש ב-Acme, ניסיון עם Workday ו-SAP SuccessFactors", "he", true],
    ["Dana Levi, HR Manager at Acme", "en", true],
    ["Dana Levi — דנה לוי — HR Manager, Acme Ltd, Tel Aviv, Workday, SAP SuccessFactors, Greenhouse", "en", false],
    ["דנה לוי, מנהלת משאבי אנוש, Dana Levi, HR, Acme, Workday, SuccessFactors", "he", false],
    ["2019 – 2024", null, false],
  ])("is sure of the language of %s only when the text is clearly one language", (text, language, certain) => {
    expect(detectDocumentLanguage(text)).toEqual({ language, certain });
  });

  it("recognises LinkedIn PDF exports", () => {
    expect(classifySource("Contact\nwww.linkedin.com/in/dana-levi (LinkedIn)\nExperience\nPage 1 of 3")).toBe("linkedin_export");
    expect(classifySource("Dana Levi — CV\nlinkedin.com/in/dana-levi\nExperience")).toBe("cv");
  });

  it.each([
    ["https://www.linkedin.com/in/dana-levi/", "https://www.linkedin.com/in/dana-levi"],
    ["here you go: linkedin.com/in/dana_levi-123", "https://linkedin.com/in/dana_levi-123"],
    ["http://il.linkedin.com/in/dana", "http://il.linkedin.com/in/dana"],
    ["skip", null],
    ["https://linkedin.com/company/acme", null],
  ])("parses LinkedIn URL from %s", (input, expected) => {
    expect(parseLinkedinUrl(input)).toBe(expected);
  });
});
