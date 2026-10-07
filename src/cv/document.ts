import type { ConversationLanguage, CvFileFormat } from "../domain/enums.js";
import { detectLanguage } from "../domain/language.js";

/** Everything a rendered CV shows; both the DOCX and the PDF are laid out from this alone. */
export interface CvDocumentContent {
  language: ConversationLanguage;
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

export type CvBlockStyle = "name" | "headline" | "contact" | "heading" | "text" | "role" | "period" | "bullet";

/** One paragraph of the CV, in reading order. */
export interface CvBlock {
  style: CvBlockStyle;
  text: string;
  /** Paragraph direction: right to left puts the paragraph, and its bullet, on the right. */
  rtl: boolean;
  /** Run direction, which decides how word processors order digits and punctuation that have no direction of their own. */
  rtlRun: boolean;
  keepWithNext: boolean;
}

type Heading = "summary" | "experience" | "skills" | "education" | "certifications" | "languages" | "other";

export const CV_HEADINGS: Record<ConversationLanguage, Record<Heading, string>> = {
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
const PRESENT: Record<ConversationLanguage, string> = { en: "Present", he: "היום" };

const LRM = "\u200E";
const HEBREW = /[\u0590-\u05FF]/;
const LATIN = /[A-Za-z]/;

/** Lays the content out as paragraphs; Latin-only lines of a Hebrew CV are wrapped in left-to-right marks so `Python.` doesn't read `.Python`. */
export function cvBlocks(content: CvDocumentContent): CvBlock[] {
  const rtlDocument = content.language === "he";
  const block = (style: CvBlockStyle, text: string, keepWithNext = false): CvBlock => {
    const hebrew = HEBREW.test(text);
    const latin = LATIN.test(text);
    if (rtlDocument) {
      const ltrOnly = !hebrew && latin;
      return { style, text: ltrOnly ? `${LRM}${text}${LRM}` : text, rtl: true, rtlRun: !ltrOnly, keepWithNext };
    }
    return { style, text, rtl: detectLanguage(text) === "he", rtlRun: hebrew, keepWithNext };
  };
  const headings = CV_HEADINGS[content.language];

  const blocks: CvBlock[] = [block("name", content.name)];
  if (content.headline) blocks.push(block("headline", content.headline));
  if (content.contact.length) blocks.push(block("contact", content.contact.join(" | ")));

  if (content.summary.length) blocks.push(block("heading", headings.summary, true), block("text", content.summary.join(" ")));
  if (content.experiences.length) {
    blocks.push(block("heading", headings.experience, true));
    for (const role of content.experiences) {
      blocks.push(
        block("role", `${role.title} — ${role.employer}`, true),
        block("period", period(role, content.language), role.bullets.length > 0),
        ...role.bullets.map((b) => block("bullet", b)),
      );
    }
  }
  if (content.skills.length) blocks.push(block("heading", headings.skills, true), block("text", content.skills.join(" · ")));
  const lists = [
    [headings.education, content.education],
    [headings.certifications, content.certifications],
    [headings.languages, content.languages],
    [headings.other, content.other],
  ] as const;
  for (const [title, items] of lists) {
    if (items.length) blocks.push(block("heading", title, true), ...items.map((i) => block("bullet", i)));
  }
  return blocks;
}

export function cvFileName(name: string, jobTitle: string, format: CvFileFormat): string {
  const clean = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
  return `${clean(`CV - ${name} - ${jobTitle}`).slice(0, 120)}.${format}`;
}

function period(role: CvDocumentContent["experiences"][number], language: ConversationLanguage): string {
  const month = (date: string | null) => (date ? `${date.slice(5, 7)}/${date.slice(0, 4)}` : "?");
  return `${month(role.startDate)} – ${role.isCurrent ? PRESENT[language] : month(role.endDate)}`;
}
