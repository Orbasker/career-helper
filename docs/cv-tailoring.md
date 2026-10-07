# Master CV and tailoring

Code: `src/cv/tailoring.ts` (rules and grounding), `src/cv/language.ts` (language choice), `src/ai/cv-tailorer.ts` (LLM), `src/cv/document.ts`, `src/cv/render-docx.ts` and `src/cv/render-pdf.ts` (files), `src/app/postgres/cv.ts` (persistence). Tables: `source_documents`, `cv_versions`, `cv_version_items`, `cv_version_files` (see `docs/domain-model.md`).

## Master CV

The truth lives in the confirmed profile:

- **Verified** `work_experiences` hold employers, titles and dates.
- **Verified** `career_facts` hold responsibilities, achievements, skills, education, certifications, languages and other facts.

The uploaded CVs stay in `source_documents` for reference, one row per file and language, and each extracted fact points back at its document through `source_document_id`. Wording in an uploaded CV is never trusted on its own: facts extracted from it are `unverified` until the user confirms them. `cv_versions.source_document_id` records the CV a version was based on: the user's default CV in the version's language, otherwise the newest readable CV in that language, otherwise the default or newest readable CV in any language. Removed CVs are never used. Facts are never edited in place (a correction rejects the old fact and creates a new one), so a fact id is stable provenance.

A tailored CV is presentation only. Each `cv_version_items` row is one line of generated text pointing at the verified fact it presents. A database trigger rejects lines that cite unverified facts or another user's facts. Role headers (title, employer, dates) are never generated; they are read from `work_experiences` when the CV is shown or rendered, so they stay as written in the profile in either language.

## Language

Every version is written in English or Hebrew (`cv_versions.language`), chosen in this order (`chooseCvLanguage`) and recorded in `language_source`:

| Order | Rule | `language_source` |
| --- | --- | --- |
| 1 | The language the user asked for (a **🌐 version** button) | `requested` |
| 2 | The posting's language when it is clear: Hebrew when more than 30% of its letters are Hebrew, English when less than 5% are, nothing for short or mixed postings | `job` |
| 3 | The language of the user's readable CVs, when they are all in one language | `cv` |
| 4 | The conversation language (English when not chosen) | `conversation` |

The same job can have an English and a Hebrew version side by side: there is at most one open version per user, match and language.

## Tailoring a CV for a job

**Tailor my CV** on a match creates a `requested` version in the chosen language, and the bot generates the draft right away:

1. **Choose and order.** The model sees only the user's verified experiences and facts, as aliases (`e1`, `f3`), plus the job posting. It picks the responsibilities and achievements that matter most for the job, most relevant first: up to 5 per role and 15 in total. It also orders the skills.
2. **Tailor the wording.** Each bullet restates exactly one fact in the job's terminology, written in the version's language: facts in the other language are translated faithfully, keeping numbers and names. The model also writes a summary of up to 3 sentences and a short application note, each citing the aliases it relies on, and translates the skill, education, certification and language facts written in the other language. The user's uploaded CV in the version's language, when there is one, is passed as a `<style_reference>` for terminology and tone only; it is never a source of facts and everything written still goes through grounding.
3. **Grounding** (`groundTailoring`) maps aliases back to real facts and enforces the truth rules:

   | Generated text | Rule | If it breaks the rule |
   | --- | --- | --- |
   | Experience / other bullet | Must cite a responsibility, achievement or other fact | Replaced by the fact's own wording |
   | Summary sentence | Must cite at least one fact | Dropped |
   | Application note | Must cite at least one fact | Removed (`application_note` is null) |
   | Skills | Chosen by id only | Copied verbatim, or translated when written in the other language |
   | Education, certifications, languages | Not chosen by the model | All included, copied verbatim or translated when written in the other language |
   | Translation | Only for a fact in the other language, and claims nothing the fact doesn't | The fact's own wording |

   `unsupportedClaims` treats a line as claiming too much when it contains:
   - a number (including years) that its cited facts and their roles don't contain;
   - the employer of a role it doesn't cite;
   - in bullets and the summary, the target company named as if the user worked there.

   Names are compared as written, so a name transliterated into the other script is not caught; numbers are checked in every language.
4. **Retry.** If any text was replaced or dropped, the model is asked once more, with the rejected claims listed. The attempt with fewer violations is kept. Remaining violations are logged as `cv.tailor.violations`.
5. **Save.** In one transaction, the version moves from `requested` to `draft` together with its items, `application_note`, `profile_revision`, `model` and `prompt_version` (`CV_TAILORING_PROMPT_VERSION`).

## Another language

**🌐 Hebrew version** / **🌐 English version** on a draft or a sent CV (`cvl:<language>:<versionId>`, `requestLanguage`):

- An approved version of the same match in that language is sent as it is, with no new tailoring.
- An open draft in that language is sent again.
- Otherwise a new version is requested with `language_source = requested` and `based_on_version_id` pointing at the original. Its highlights and skills are passed to the model as a `<keep>` list so it translates the same selection, in the same order, instead of choosing again. The new version is a draft and needs its own approval.

## Review

The bot sends the draft (title, language and why it was chosen, summary, roles with bullets, skills, education, languages, application note) with **Approve** / **Discard** (`cvd:<a|x>:<versionId>`) and **🌐 <other language> version**:

- **Approve** moves the version to `approved` (with `approved_at`) and sends the CV as a Word document (see below).
- **Discard** moves it to `rejected`. Tapping **Tailor my CV** again starts a new version.

| State when the user taps **Tailor my CV** | Result |
| --- | --- |
| No open version in the chosen language | New `requested` version, tailored immediately |
| `requested` for less than 10 minutes | "Already being prepared" |
| `requested` for longer | Marked `failed` and replaced by a new request |
| `draft` | The draft is sent again |
| Tailoring threw | Version `failed` with `failure_reason`; the user can retry |

## Documents (DOCX and PDF)

Both files are laid out from the same content, so a version reads the same in Word and as a PDF:

- `PgCvService.document` assembles the content from the stored version:
  - language from `cv_versions.language`;
  - name from `users.display_name`;
  - headline and LinkedIn URL from `career_profiles`;
  - roles from verified `work_experiences`;
  - every other line from `cv_version_items`.
- `cvBlocks` (`src/cv/document.ts`) turns the content into paragraphs with their direction. `renderCvDocx` (the `docx` library) and `renderCvPdf` (`pdf-lib`) only lay those paragraphs out. They never generate or change text, and the same content always produces the same file.

The template is A4. In order: name, headline, contact line, then Summary, Experience (title — employer, dates as `MM/YYYY – Present`, bullets), Skills (one line), Education, Certifications, Languages and Additional. Empty sections are left out. The application note is not part of the CV; it is shown in the draft message. The DOCX uses Arial; the PDF embeds Arimo (`assets/fonts`, SIL Open Font License), which has Arial's metrics and covers Hebrew.

**Hebrew:** a Hebrew version has Hebrew headings and "היום" for Present, and every paragraph is right to left, so text and bullets sit on the right and dates read from the right (`02/2021 – 01/2018` starts on the right). A line with only Latin text (e.g. `English (fluent).`) is wrapped in left-to-right marks so its punctuation stays where English puts it. In an English version, a line written mostly in Hebrew is right to left. In the DOCX, right-to-left paragraphs get no explicit alignment, because Word reads `jc=right` in a right-to-left paragraph as left; runs with Hebrew, or with only digits and punctuation, are marked right to left. The PDF orders each wrapped line with the Unicode bidirectional algorithm (`bidi-js`), which mirrors brackets and orders mixed Hebrew and English the way Word does.

After **Approve**, the bot sends the Word file (`CV - <name> - <job title>.docx`) with **📕 PDF** and **🌐 <other language> version** buttons; the PDF (`.pdf`) comes with **📝 Word** instead (`cvf:<d|p>:<versionId>`). Each sent file's Telegram `file_id` is stored per format in `cv_version_files`, so later sends reuse it instead of rendering again. If rendering fails, the version stays approved and the bot offers a **Send document** button to retry that format.
