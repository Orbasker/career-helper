import type { ProfileSourceKind } from "../domain/enums.js";
import type { IncomingDocument } from "./services.js";

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MIN_TEXT_LENGTH = 40;

function extension(fileName: string | null): string {
  return fileName?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
}

export async function readDocumentText(document: IncomingDocument): Promise<string | null> {
  const ext = extension(document.fileName);
  const mime = document.mimeType ?? "";
  let text: string;
  if (mime === "application/pdf" || ext === "pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(document.data);
    text = (await extractText(pdf, { mergePages: true })).text;
  } else if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || ext === "docx") {
    const mammoth = await import("mammoth");
    text = (await mammoth.extractRawText({ buffer: Buffer.from(document.data) })).value;
  } else if (mime.startsWith("text/") || ext === "txt" || ext === "md") {
    text = new TextDecoder().decode(document.data);
  } else {
    return null;
  }
  const normalized = text.replace(/\u0000/g, "").replace(/[ \t]+\n/g, "\n").trim();
  return normalized.length >= MIN_TEXT_LENGTH ? normalized : null;
}

export function classifySource(text: string): ProfileSourceKind {
  return /linkedin\.com\/in\//i.test(text) && /Page \d+ of \d+/i.test(text) ? "linkedin_export" : "cv";
}

const LINKEDIN_URL = /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%]+\/?/i;

export function parseLinkedinUrl(text: string): string | null {
  const match = text.match(LINKEDIN_URL)?.[0];
  if (!match) return null;
  return (match.startsWith("http") ? match : `https://${match}`).replace(/\/$/, "");
}
