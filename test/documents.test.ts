import { describe, expect, it } from "vitest";
import { classifySource, parseLinkedinUrl, readDocumentText } from "../src/app/documents.js";

function minimalPdf(text: string): Uint8Array {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  return new TextEncoder().encode(
    [
      "%PDF-1.4",
      "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
      "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
      "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj",
      `4 0 obj<</Length ${content.length}>>stream\n${content}\nendstream endobj`,
      "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
      "trailer<</Root 1 0 R>>",
      "%%EOF",
    ].join("\n"),
  );
}

const doc = (fileName: string, mimeType: string | null, data: Uint8Array) => ({ fileRef: "f", fileName, mimeType, data });

describe("documents", () => {
  it("reads text from PDF and plain-text files", async () => {
    const text = "HR Manager at Acme Ltd since 2019, managed six recruiters";
    expect(await readDocumentText(doc("cv.pdf", "application/pdf", minimalPdf(text)))).toBe(text);
    expect(await readDocumentText(doc("cv.txt", null, new TextEncoder().encode(`  ${text}  \n`)))).toBe(text);
  });

  it("returns null for unsupported or near-empty files", async () => {
    expect(await readDocumentText(doc("photo.jpg", "image/jpeg", new Uint8Array([1, 2])))).toBeNull();
    expect(await readDocumentText(doc("cv.txt", "text/plain", new TextEncoder().encode("hi")))).toBeNull();
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
