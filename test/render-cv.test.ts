import JSZip from "jszip";
import mammoth from "mammoth";
import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { extractText, getDocumentProxy } from "unpdf";
import { describe, expect, it } from "vitest";
import { cvBlocks, cvFileName, type CvDocumentContent } from "../src/cv/document.js";
import { renderCvDocx } from "../src/cv/render-docx.js";
import { PAGE, layoutCvPdf, renderCvPdf } from "../src/cv/render-pdf.js";

const english: CvDocumentContent = {
  language: "en",
  name: "Dana Levi",
  headline: "Backend Engineer – Python, AWS & DevOps automation",
  contact: ["https://linkedin.com/in/dana"],
  summary: ["Backend engineer who automated NOC operations.", "Builds Python services on AWS."],
  experiences: [
    {
      title: "NOC Engineer",
      employer: "Via",
      startDate: "2021-03-01",
      endDate: null,
      isCurrent: true,
      bullets: ["Automated incident triage with Python", "Ran on-call for 40 services"],
    },
    { title: "Field Application Specialist", employer: "Juganu", startDate: "2018-01-01", endDate: "2021-02-01", isCurrent: false, bullets: [] },
  ],
  skills: ["Python", "AWS", "Terraform"],
  education: ["BSc Computer Science, Tel Aviv University"],
  certifications: [],
  languages: ["Hebrew (native)", "English (fluent)"],
  other: [],
};

const hebrew: CvDocumentContent = {
  ...english,
  language: "he",
  name: "דנה לוי",
  headline: "מהנדסת בקאנד",
  summary: ["מהנדסת בקאנד עם ניסיון באוטומציה של תפעול רשת."],
  experiences: [
    { ...english.experiences[0]!, title: "מהנדסת NOC", bullets: ["אוטומציה של טיפול בתקלות ב-Python."] },
    { ...english.experiences[1]!, title: "מומחית יישום שטח" },
  ],
  skills: ["Python"],
  education: ["תואר ראשון במדעי המחשב, אוניברסיטת תל אביב"],
  languages: ["עברית (שפת אם)", "English (fluent)."],
};

const LRM = "‎";

async function documentXml(data: Uint8Array) {
  return (await JSZip.loadAsync(data)).file("word/document.xml")!.async("string");
}

function expectInOrder(text: string, pieces: string[]) {
  let cursor = 0;
  for (const piece of pieces) {
    const at = text.indexOf(piece, cursor);
    expect(at, piece).toBeGreaterThanOrEqual(cursor);
    cursor = at + piece.length;
  }
}

const ENGLISH_ORDER = [
  "Dana Levi",
  "Backend Engineer – Python, AWS & DevOps automation",
  "https://linkedin.com/in/dana",
  "Summary",
  "Backend engineer who automated NOC operations. Builds Python services on AWS.",
  "Experience",
  "NOC Engineer — Via",
  "03/2021 – Present",
  "Automated incident triage with Python",
  "Field Application Specialist — Juganu",
  "01/2018 – 02/2021",
  "Skills",
  "Python · AWS · Terraform",
  "Education",
  "Languages",
  "English (fluent)",
];

describe("cvBlocks", () => {
  it("makes a Hebrew CV right to left and keeps Latin-only lines' punctuation in English order", () => {
    const blocks = cvBlocks(hebrew);
    expect(blocks.every((b) => b.rtl)).toBe(true);
    expect(blocks.find((b) => b.text.includes("fluent"))).toMatchObject({ text: `${LRM}English (fluent).${LRM}`, rtlRun: false });
    expect(blocks.find((b) => b.text.includes("Python."))).toMatchObject({ text: "אוטומציה של טיפול בתקלות ב-Python.", rtlRun: true });
    expect(blocks.find((b) => b.style === "period" && b.text.includes("2018"))).toMatchObject({ text: "01/2018 – 02/2021", rtlRun: true });
    expect(blocks.filter((b) => b.style === "heading").map((b) => b.text)).toEqual(["תקציר", "ניסיון תעסוקתי", "כישורים", "השכלה", "שפות"]);
  });

  it("keeps an English CV left to right except for lines written in Hebrew", () => {
    const blocks = cvBlocks({ ...english, languages: ["עברית (שפת אם)", "English (fluent)"] });
    expect(blocks.filter((b) => b.rtl).map((b) => b.text)).toEqual(["עברית (שפת אם)"]);
    expect(blocks.some((b) => b.text.includes(LRM))).toBe(false);
  });
});

describe("renderCvDocx", () => {
  it("renders every section of an English CV in order", async () => {
    const data = await renderCvDocx(english);
    const { value: text } = await mammoth.extractRawText({ buffer: Buffer.from(data) });
    expectInOrder(text, ENGLISH_ORDER);
    expect(text).not.toContain("Certifications");
    expect(await documentXml(data)).not.toContain("<w:bidi");
  });

  it("renders a Hebrew CV as right-to-left paragraphs that Word aligns to the right", async () => {
    const data = await renderCvDocx(hebrew);
    const { value: text } = await mammoth.extractRawText({ buffer: Buffer.from(data) });
    expect(text).toContain("ניסיון תעסוקתי");
    expect(text).toContain("03/2021 – היום");

    const xml = await documentXml(data);
    const paragraphs = xml.split("<w:p>").slice(1);
    const paragraphWith = (needle: string) => paragraphs.find((p) => p.includes(needle))!;
    expect(paragraphs.every((p) => p.includes("<w:bidi/>"))).toBe(true);
    expect(xml).not.toContain('<w:jc w:val="right"/>');
    expect(paragraphWith("דנה לוי")).toContain("<w:rtl/>");
    expect(paragraphWith("02/2021")).toContain("<w:rtl/>");
    expect(paragraphWith("English (fluent).")).not.toContain("<w:rtl/>");
  });

  it("produces the same document for the same content", async () => {
    const [a, b] = await Promise.all([renderCvDocx(english), renderCvDocx(english)]);
    expect(await documentXml(a)).toEqual(await documentXml(b));
  });
});

describe("renderCvPdf", () => {
  const rightEdge = PAGE.width - PAGE.right;

  it("renders every section of an English CV in order with the fonts embedded", async () => {
    const data = await renderCvPdf(english);
    const { text } = await extractText(await getDocumentProxy(data.slice()), { mergePages: true });
    expectInOrder(text.replace(/\s+/g, " "), ENGLISH_ORDER);
    const objects = (await PDFDocument.load(data)).context.enumerateIndirectObjects();
    const fontNames = objects.flatMap(([, object]) => (object instanceof PDFDict ? (object.get(PDFName.of("FontName"))?.toString() ?? []) : []));
    expect(fontNames.map((n) => n.replace(/^\/(?:[A-Z]{6}\+)?|-\d+$/g, "")).sort()).toEqual(["Arimo-Bold", "Arimo-Italic", "Arimo-Regular"]);
  });

  it("lays an English CV out from the left margin", async () => {
    const lines = await layoutCvPdf(english);
    expect(lines.find((l) => l.text === "Dana Levi")).toMatchObject({ x: PAGE.left, page: 0 });
    expect(lines.find((l) => l.text === "Ran on-call for 40 services")).toMatchObject({ bullet: { x: PAGE.left + 2 } });
    expect(lines.filter((l) => l.rule).map((l) => l.text)).toEqual(["Summary", "Experience", "Skills", "Education", "Languages"]);
  });

  it("lays a Hebrew CV out right to left, in visual order, with mixed text and dates ordered for Hebrew readers", async () => {
    const lines = await layoutCvPdf(hebrew);
    const line = (text: string) => lines.find((l) => l.text === text);

    expect(line("יול הנד")!.x + line("יול הנד")!.width).toBeCloseTo(rightEdge, 1);
    expect(line(".Python-ב תולקתב לופיט לש היצמוטוא")).toBeDefined();
    expect(line("02/2021 – 01/2018")).toBeDefined();
    expect(line("םויה – 03/2021")).toBeDefined();
    const english = line("English (fluent).")!;
    expect(english.x + english.width).toBeCloseTo(rightEdge - 14, 1);
    expect(english.bullet!.x).toBeGreaterThan(english.x + english.width);
    expect(lines.some((l) => l.text.includes(LRM))).toBe(false);
  });

  it("wraps long lines within the margins and continues on a new page", async () => {
    const long = "Partnered with engineering leadership on organization design, performance cycles, compensation reviews and retention programs.";
    const lines = await layoutCvPdf({ ...english, experiences: [{ ...english.experiences[0]!, bullets: Array.from({ length: 60 }, () => long) }] });
    const bullets = lines.filter((l) => l.style === "bullet");
    expect(bullets.filter((l) => l.bullet).length).toBe(60 + english.education.length + english.languages.length);
    expect(bullets.length).toBeGreaterThan(120);
    expect(Math.max(...lines.map((l) => l.x + l.width))).toBeLessThanOrEqual(rightEdge + 0.01);
    expect(Math.min(...lines.map((l) => l.y))).toBeGreaterThanOrEqual(PAGE.bottom);
    expect(lines.at(-1)!.page).toBeGreaterThan(0);
  });

  it("produces the same file for the same content", async () => {
    const [a, b] = await Promise.all([renderCvPdf(hebrew), renderCvPdf(hebrew)]);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});

describe("cvFileName", () => {
  it("names the file after the candidate, job and format without unsafe characters", () => {
    expect(cvFileName("Dana Levi", "Backend Engineer / Platform", "docx")).toBe("CV - Dana Levi - Backend Engineer Platform.docx");
    expect(cvFileName("דנה", "מפתח: בקאנד", "pdf")).toBe("CV - דנה - מפתח בקאנד.pdf");
  });
});
