import type { ConversationLanguage, DocumentFormat, DocumentKind } from "../domain/enums.js";
import type { IncomingDocument } from "./services.js";

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MIN_TEXT_LENGTH = 40;
const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export type ParsedDocument =
  | { status: "parsed"; format: DocumentFormat; text: string; language: ConversationLanguage | null; languageCertain: boolean }
  | { status: "unsupported" | "failed"; format: DocumentFormat; error: string };

function extension(fileName: string | null): string {
  return fileName?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
}

export function documentFormat(document: Pick<IncomingDocument, "fileName" | "mimeType" | "data">): DocumentFormat {
  const ext = extension(document.fileName);
  const mime = document.mimeType ?? "";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || ext === "docx") return "docx";
  if (mime === "application/msword" || ext === "doc" || OLE_SIGNATURE.every((b, i) => document.data[i] === b)) return "doc";
  if (mime.startsWith("text/") || ext === "txt" || ext === "md") return "txt";
  return "other";
}

export interface DetectedLanguage {
  language: ConversationLanguage | null;
  /** False for mixed text, where the user should confirm the language. */
  certain: boolean;
}

/** Hebrew CVs routinely contain English terms, so a modest share of Hebrew letters is enough to call it Hebrew. */
export function detectDocumentLanguage(text: string): DetectedLanguage {
  const hebrew = text.match(/[\u05D0-\u05EA]/g)?.length ?? 0;
  const latin = text.match(/[A-Za-z]/g)?.length ?? 0;
  const share = hebrew / (hebrew + latin || 1);
  if (share > 0.3) return { language: "he", certain: share >= 0.4 };
  if (latin === 0) return { language: null, certain: false };
  return { language: "en", certain: share <= 0.05 };
}

export function detectLanguage(text: string): ConversationLanguage | null {
  return detectDocumentLanguage(text).language;
}

async function extractText(format: DocumentFormat, data: Uint8Array): Promise<string> {
  switch (format) {
    case "pdf": {
      const { extractText, getDocumentProxy } = await import("unpdf");
      return (await extractText(await getDocumentProxy(data), { mergePages: true })).text;
    }
    case "docx": {
      const mammoth = await import("mammoth");
      return (await mammoth.extractRawText({ buffer: Buffer.from(data) })).value;
    }
    default:
      return new TextDecoder().decode(data);
  }
}

export async function parseDocument(document: IncomingDocument): Promise<ParsedDocument> {
  const format = documentFormat(document);
  if (format === "doc") return { status: "unsupported", format, error: "legacy Word .doc format" };
  if (format === "other") return { status: "unsupported", format, error: `unsupported file type ${document.mimeType ?? "unknown"}` };
  let text: string;
  try {
    text = await extractText(format, document.data);
  } catch (error) {
    return { status: "failed", format, error: error instanceof Error ? error.message : String(error) };
  }
  const normalized = text.replace(/\u0000/g, "").replace(/[ \t]+\n/g, "\n").trim();
  if (normalized.length < MIN_TEXT_LENGTH) return { status: "failed", format, error: "no readable text" };
  const { language, certain } = detectDocumentLanguage(normalized);
  return { status: "parsed", format, text: normalized, language, languageCertain: certain };
}

export function classifySource(text: string): DocumentKind {
  return /linkedin\.com\/in\//i.test(text) && /Page \d+ of \d+/i.test(text) ? "linkedin_export" : "cv";
}

const LINKEDIN_URL = /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%]+\/?/i;

export function parseLinkedinUrl(text: string): string | null {
  const match = text.match(LINKEDIN_URL)?.[0];
  if (!match) return null;
  return (match.startsWith("http") ? match : `https://${match}`).replace(/\/$/, "");
}
