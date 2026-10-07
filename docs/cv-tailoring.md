# Master CV and tailoring

Code: `src/cv/tailoring.ts` (rules and grounding), `src/ai/cv-tailorer.ts` (LLM), `src/app/postgres/cv.ts` (persistence). Tables: `source_documents`, `cv_versions`, `cv_version_items` (see `docs/domain-model.md`).

## Master CV

The truth lives in the confirmed profile:

- **Verified** `work_experiences` hold employers, titles and dates.
- **Verified** `career_facts` hold responsibilities, achievements, skills, education, certifications, languages and other facts.

The uploaded CVs stay in `source_documents` for reference, one row per file and language, and each extracted fact points back at its document through `source_document_id`. Wording in an uploaded CV is never trusted on its own: facts extracted from it are `unverified` until the user confirms them. `cv_versions.source_document_id` records the latest readable CV when the version was requested. Facts are never edited in place (a correction rejects the old fact and creates a new one), so a fact id is stable provenance.

A tailored CV is presentation only. Each `cv_version_items` row is one line of generated text pointing at the verified fact it presents. A database trigger rejects lines that cite unverified facts or another user's facts. Role headers (title, employer, dates) are never generated; they are read from `work_experiences` when the CV is shown or rendered.

## Tailoring a CV for a job

**Tailor my CV** on a match creates a `requested` version, and the bot generates the draft right away:

1. **Choose and order.** The model sees only the user's verified experiences and facts, as aliases (`e1`, `f3`), plus the job posting. It picks the responsibilities and achievements that matter most for the job, most relevant first: up to 5 per role and 15 in total. It also orders the skills.
2. **Tailor the wording.** Each bullet restates exactly one fact in the job's language. The model also writes a summary of up to 3 sentences and a short application note, each citing the aliases it relies on.
3. **Grounding** (`groundTailoring`) maps aliases back to real facts and enforces the truth rules:

   | Generated text | Rule | If it breaks the rule |
   | --- | --- | --- |
   | Experience / other bullet | Must cite a responsibility, achievement or other fact | Replaced by the fact's own wording |
   | Summary sentence | Must cite at least one fact | Dropped |
   | Application note | Must cite at least one fact | Removed (`application_note` is null) |
   | Skills | Chosen by id only | Always copied verbatim |
   | Education, certifications, languages | Not chosen by the model | All copied verbatim |

   `unsupportedClaims` treats a line as claiming too much when it contains:
   - a number (including years) that its cited facts and their roles don't contain;
   - the employer of a role it doesn't cite;
   - in bullets and the summary, the target company named as if the user worked there.
4. **Retry.** If any text was replaced or dropped, the model is asked once more, with the rejected claims listed. The attempt with fewer violations is kept. Remaining violations are logged as `cv.tailor.violations`.
5. **Save.** In one transaction, the version moves from `requested` to `draft` together with its items, `application_note`, `profile_revision`, `model` and `prompt_version` (`CV_TAILORING_PROMPT_VERSION`).

The text is written in the language of the user's facts.

## Review

The bot sends the draft (summary, roles with bullets, skills, education, languages, application note) with **Approve** / **Discard** (`cvd:<a|x>:<versionId>`):

- **Approve** moves the version to `approved` (with `approved_at`) and sends the CV as a Word document (see below).
- **Discard** moves it to `rejected`. Tapping **Tailor my CV** again starts a new version.

| State when the user taps **Tailor my CV** | Result |
| --- | --- |
| No open version | New `requested` version, tailored immediately |
| `requested` for less than 10 minutes | "Already being prepared" |
| `requested` for longer | Marked `failed` and replaced by a new request |
| `draft` | The draft is sent again |
| Tailoring threw | Version `failed` with `failure_reason`; the user can retry |

## Document (DOCX)

`src/cv/render-docx.ts` renders an approved version with the `docx` library. Content and layout are kept separate:

- `PgCvService.document` assembles the content from the stored version:
  - name from `users.display_name`;
  - headline and LinkedIn URL from `career_profiles`;
  - roles from verified `work_experiences`;
  - every other line from `cv_version_items`.
- `renderCvDocx` only lays that content out. It never generates or changes text, and the same content always produces the same document.

The template is A4 and uses Arial. In order: name, headline, contact line, then Summary, Experience (title — employer, dates as `MM/YYYY – Present`, bullets), Skills (one line), Education, Certifications, Languages and Additional. Empty sections are left out. The application note is not part of the CV; it is shown in the draft message.

**Hebrew:** when the CV text has more Hebrew than Latin letters, the headings and "Present" are in Hebrew. Every paragraph with Hebrew text is right-to-left and right-aligned, and lines that are only Latin text (e.g. `Python`) stay left-to-right. Arial covers both scripts.

After **Approve**, the bot sends the file (`CV - <name> - <job title>.docx`) and stores the Telegram `file_id` in `cv_versions.rendered_file_ref`, so later sends reuse it instead of rendering again. If rendering fails, the version stays approved and the bot offers a **Send document** button (`cvf:<versionId>`) to retry.

PDF is not produced yet.
