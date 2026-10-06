import { AlignmentType, BorderStyle, Document, Packer, Paragraph, TextRun, type IParagraphOptions } from "docx";

export interface CvDocumentContent {
  name: string;
  headline: string | null;
  contact: string[];
  summary: string[];
  experiences: {
    title: string;
    employer: string;
    startDate: string | null;
    endDate: string | null;
    isCurrent: boolean;
    bullets: string[];
  }[];
  skills: string[];
  education: string[];
  certifications: string[];
  languages: string[];
  other: string[];
}

export type CvLanguage = "en" | "he";

const HEADINGS: Record<CvLanguage, Record<"summary" | "experience" | "skills" | "education" | "certifications" | "languages" | "other", string>> = {
  en: {
    summary: "Summary",
    experience: "Experience",
    skills: "Skills",
    education: "Education",
    certifications: "Certifications",
    languages: "Languages",
    other: "Additional",
  },
  he: {
    summary: "תקציר",
    experience: "ניסיון תעסוקתי",
    skills: "כישורים",
    education: "השכלה",
    certifications: "הסמכות",
    languages: "שפות",
    other: "נוסף",
  },
};
const PRESENT: Record<CvLanguage, string> = { en: "Present", he: "היום" };

const FONT = "Arial";
const BODY_SIZE = 21;
const ACCENT = "1F3864";
const MUTED = "595959";
const HEBREW = /[֐-׿]/g;
const LATIN = /[A-Za-z]/g;

/** Hebrew when the CV has more Hebrew than Latin letters; it then reads right to left with Hebrew headings. */
export function cvLanguage(content: CvDocumentContent): CvLanguage {
  const text = [
    content.headline ?? "",
    ...content.summary,
    ...content.experiences.flatMap((e) => [e.title, ...e.bullets]),
    ...content.education,
    ...content.certifications,
    ...content.languages,
    ...content.other,
  ].join(" ");
  const count = (pattern: RegExp) => text.match(new RegExp(pattern, "g"))?.length ?? 0;
  return count(HEBREW) > count(LATIN) ? "he" : "en";
}

export function cvFileName(name: string, jobTitle: string): string {
  const clean = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
  return `${clean(`CV - ${name} - ${jobTitle}`).slice(0, 120)}.docx`;
}

/** Renders the CV with one fixed template; the same content always produces the same document. */
export async function renderCvDocx(content: CvDocumentContent): Promise<Uint8Array> {
  const language = cvLanguage(content);
  const rtl = language === "he";
  const headings = HEADINGS[language];
  const isRtl = (text: string) => HEBREW.test(text) || (rtl && !LATIN.test(text));
  const paragraph = (text: string, run: Partial<ConstructorParameters<typeof TextRun>[0] & object> = {}, options: IParagraphOptions = {}) => {
    const right = isRtl(text);
    return new Paragraph({
      ...(right ? { bidirectional: true } : {}),
      alignment: right ? AlignmentType.RIGHT : AlignmentType.LEFT,
      spacing: { after: 60 },
      ...options,
      children: [new TextRun({ text, font: FONT, size: BODY_SIZE, rightToLeft: right, ...run })],
    });
  };
  const heading = (text: string) =>
    paragraph(
      text,
      { bold: true, size: 24, color: ACCENT },
      {
        spacing: { before: 240, after: 100 },
        keepNext: true,
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: ACCENT, space: 2 } },
      },
    );
  const bullet = (text: string) => paragraph(text, {}, { bullet: { level: 0 }, spacing: { after: 40 } });

  const children: Paragraph[] = [paragraph(content.name, { bold: true, size: 36, color: ACCENT }, { spacing: { after: 40 } })];
  if (content.headline) children.push(paragraph(content.headline, { size: 24, color: MUTED }));
  if (content.contact.length) children.push(paragraph(content.contact.join(" | "), { size: 19, color: MUTED }));

  if (content.summary.length) children.push(heading(headings.summary), paragraph(content.summary.join(" ")));
  if (content.experiences.length) {
    children.push(heading(headings.experience));
    for (const role of content.experiences) {
      children.push(
        paragraph(`${role.title} — ${role.employer}`, { bold: true }, { keepNext: true, spacing: { before: 120, after: 0 } }),
        paragraph(period(role, language), { italics: true, color: MUTED, size: 19 }, { keepNext: role.bullets.length > 0 }),
        ...role.bullets.map(bullet),
      );
    }
  }
  if (content.skills.length) children.push(heading(headings.skills), paragraph(content.skills.join(" · ")));
  const lists = [
    [headings.education, content.education],
    [headings.certifications, content.certifications],
    [headings.languages, content.languages],
    [headings.other, content.other],
  ] as const;
  for (const [title, items] of lists) if (items.length) children.push(heading(title), ...items.map(bullet));

  const document = new Document({
    creator: "Career Agent",
    title: content.name,
    styles: { default: { document: { run: { font: FONT, size: BODY_SIZE } } } },
    sections: [{ properties: { page: { margin: { top: 900, bottom: 900, left: 1000, right: 1000 } } }, children }],
  });
  return new Uint8Array(await Packer.toBuffer(document));
}

function period(role: CvDocumentContent["experiences"][number], language: CvLanguage): string {
  const month = (date: string | null) => (date ? `${date.slice(5, 7)}/${date.slice(0, 4)}` : "?");
  return `${month(role.startDate)} – ${role.isCurrent ? PRESENT[language] : month(role.endDate)}`;
}
