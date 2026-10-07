import type {
  ProfileAssistant,
  ProfileExtraction,
  ProfileInterpretation,
  ProfileSourceText,
} from "../../src/app/services.js";
import type { ProfileSnapshot } from "../../src/domain/profile.js";

type InterpretInput = { snapshot: ProfileSnapshot; message: string; question: string | null };
type MergeInput = { snapshot: ProfileSnapshot; document: ProfileSourceText };

export class FakeProfileAssistant implements ProfileAssistant {
  extraction: ProfileExtraction = { changes: [], followUpQuestions: [] };
  interpretation: (input: InterpretInput) => ProfileInterpretation = () => ({ changes: [], reply: null });
  merge: (input: MergeInput) => ProfileInterpretation = () => ({ changes: [], reply: null });
  extractCalls: { linkedinUrl: string | null; sources: ProfileSourceText[] }[] = [];
  mergeCalls: MergeInput[] = [];
  interpretCalls: InterpretInput[] = [];

  async extract(input: { linkedinUrl: string | null; sources: ProfileSourceText[] }): Promise<ProfileExtraction> {
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
