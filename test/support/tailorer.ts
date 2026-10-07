import { sectionFor, type CvTailorer, type TailoredCv, type TailoringInput } from "../../src/cv/tailoring.js";

type TailorInput = TailoringInput;

/** Copies every fact verbatim into its section unless `result` is replaced. */
export class FakeCvTailorer implements CvTailorer {
  readonly model = "fake-tailor";
  readonly promptVersion = "fake-cv-v1";
  calls: TailorInput[] = [];
  result: (input: TailorInput) => TailoredCv = ({ profile, job }) => {
    const experienceIds = new Set(profile.experiences.map((e) => e.id));
    return {
      items: profile.facts.map((fact, position) => ({
        careerFactId: fact.id,
        section: sectionFor(fact, experienceIds),
        position,
        text: fact.statement,
      })),
      applicationNote: `I'd like to apply for ${job.title}.`,
      violations: [],
    };
  };

  async tailor(input: TailorInput): Promise<TailoredCv> {
    this.calls.push(input);
    return this.result(input);
  }
}
