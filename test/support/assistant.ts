import type {
  ProfileAssistant,
  ProfileExtraction,
  ProfileInterpretation,
  ProfileSourceText,
} from "../../src/app/services.js";
import type { ConversationLanguage } from "../../src/domain/enums.js";
import type { ProfileSnapshot } from "../../src/domain/profile.js";

type ExtractInput = { linkedinUrl: string | null; sources: ProfileSourceText[]; language: ConversationLanguage };
type InterpretInput = { snapshot: ProfileSnapshot; message: string; question: string | null; language: ConversationLanguage };
type MergeInput = { snapshot: ProfileSnapshot; document: ProfileSourceText };

export class FakeProfileAssistant implements ProfileAssistant {
  extraction: ProfileExtraction = { changes: [], followUpQuestions: [] };
  interpretation: (input: InterpretInput) => ProfileInterpretation = () => ({ changes: [], reply: null });
  merge: (input: MergeInput) => ProfileInterpretation = () => ({ changes: [], reply: null });
  extractCalls: ExtractInput[] = [];
  mergeCalls: MergeInput[] = [];
  interpretCalls: InterpretInput[] = [];

  async extract(input: ExtractInput): Promise<ProfileExtraction> {
    this.extractCalls.push(input);
    return this.extraction;
  }

  async interpret(input: InterpretInput): Promise<ProfileInterpretation> {
    this.interpretCalls.push(input);
    return this.interpretation(input);
  }

  async mergeDocument(input: MergeInput): Promise<ProfileInterpretation> {
    this.mergeCalls.push(input);
    return this.merge(input);
  }
}
