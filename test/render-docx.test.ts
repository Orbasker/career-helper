import JSZip from "jszip";
import mammoth from "mammoth";
import { describe, expect, it } from "vitest";
import { cvFileName, cvLanguage, renderCvDocx, type CvDocumentContent } from "../src/cv/render-docx.js";

const english: CvDocumentContent = {
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
  name: "דנה לוי",
  headline: "מהנדסת בקאנד",
  summary: ["מהנדסת בקאנד עם ניסיון באוטומציה של תפעול רשת."],
  experiences: [{ ...english.experiences[0]!, title: "מהנדסת NOC", bullets: ["אוטומציה של טיפול בתקלות ב-Python"] }],
  skills: ["Python"],
  education: ["תואר ראשון במדעי המחשב, אוניברסיטת תל אביב"],
  languages: ["עברית (שפת אם)"],
};

async function documentXml(data: Uint8Array) {
  return (await JSZip.loadAsync(data)).file("word/document.xml")!.async("string");
}

describe("renderCvDocx", () => {
  it("renders every section of an English CV in order", async () => {
    const data = await renderCvDocx(english);
    const { value: text } = await mammoth.extractRawText({ buffer: Buffer.from(data) });
    const order = [
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
    let cursor = 0;
    for (const piece of order) {
      const at = text.indexOf(piece, cursor);
      expect(at, piece).toBeGreaterThanOrEqual(cursor);
      cursor = at + piece.length;
    }
    expect(text).not.toContain("Certifications");
    expect(await documentXml(data)).not.toContain("<w:bidi");
  });

  it("renders a Hebrew CV right to left with Hebrew headings, keeping Latin-only lines left to right", async () => {
    expect(cvLanguage(hebrew)).toBe("he");
    expect(cvLanguage(english)).toBe("en");
    const data = await renderCvDocx(hebrew);
    const { value: text } = await mammoth.extractRawText({ buffer: Buffer.from(data) });
    expect(text).toContain("ניסיון תעסוקתי");
    expect(text).toContain("03/2021 – היום");

    const xml = await documentXml(data);
    const paragraphs = xml.split("<w:p>").slice(1);
    const paragraphWith = (needle: string) => paragraphs.find((p) => p.includes(needle))!;
    expect(paragraphWith("דנה לוי")).toContain("<w:bidi");
    expect(paragraphWith("<w:t xml:space=\"preserve\">Python</w:t>")).not.toContain("<w:bidi");
  });

  it("produces the same document for the same content", async () => {
    const [a, b] = await Promise.all([renderCvDocx(english), renderCvDocx(english)]);
    expect(await documentXml(a)).toEqual(await documentXml(b));
  });
});

describe("cvFileName", () => {
  it("names the file after the candidate and job without unsafe characters", () => {
    expect(cvFileName("Dana Levi", "Backend Engineer / Platform")).toBe("CV - Dana Levi - Backend Engineer Platform.docx");
    expect(cvFileName("דנה", "מפתח: בקאנד")).toBe("CV - דנה - מפתח בקאנד.docx");
  });
});
