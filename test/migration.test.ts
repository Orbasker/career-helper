import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const LAST_SINGLE_CV_MIGRATION = "0007_preferred_language";

const LAST_SINGLE_LANGUAGE_CV_MIGRATION = "0008_multi_cv_documents";

let client: PGlite;
let legacyFolder: string;

async function migrationsUpTo(tag: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "migrations-"));
  await cp("drizzle", folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: { tag: string }[] };
  const last = journal.entries.findIndex((e) => e.tag === tag);
  journal.entries = journal.entries.slice(0, last + 1);
  await writeFile(journalPath, JSON.stringify(journal));
  return folder;
}

const HEBREW_CV = "דנה לוי\nמנהלת משאבי אנוש ב-Acme\nניהלה צוות של שישה מגייסים";
const ENGLISH_CV = "Noa Cohen\nPayroll lead at Globex since 2018\nRan payroll for 400 employees";

beforeEach(async () => {
  client = new PGlite();
  legacyFolder = await migrationsUpTo(LAST_SINGLE_CV_MIGRATION);
  await migrate(drizzle(client), { migrationsFolder: legacyFolder });
});

afterEach(async () => {
  await client.close();
  await rm(legacyFolder, { recursive: true, force: true });
});

async function rows<T>(query: string): Promise<T[]> {
  return (await client.query<T>(query)).rows;
}

describe("multi-document CV migration", () => {
  it("moves single-CV data into source documents without losing provenance", async () => {
    await client.exec(`
      insert into users (id, telegram_user_id, telegram_chat_id) values
        ('00000000-0000-4000-8000-00000000000a', 1, 1),
        ('00000000-0000-4000-8000-00000000000b', 2, 2),
        ('00000000-0000-4000-8000-00000000000c', 3, 3);

      insert into profile_sources (id, user_id, kind, file_ref, file_name, content) values
        ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000a', 'cv', 'tg-he', 'קורות חיים.pdf', '${HEBREW_CV}'),
        ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-00000000000a', 'linkedin_export', 'tg-li', 'Profile.PDF', 'Dana Levi linkedin.com/in/dana Page 1 of 2'),
        ('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-00000000000a', 'pasted_text', null, null, 'I also know Workday'),
        ('10000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-00000000000c', 'cv', 'tg-c1', 'a.docx', 'First CV of user C with enough text'),
        ('10000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-00000000000c', 'cv', 'tg-c2', 'b.docx', 'Second CV of user C with enough text');

      insert into master_cvs (id, user_id, original_file_ref, original_text) values
        ('20000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000a', 'tg-he', '${HEBREW_CV}'),
        ('20000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000b', 'tg-en', '${ENGLISH_CV}');

      insert into cv_versions (id, user_id, master_cv_id) values
        ('30000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000a', '20000000-0000-4000-8000-00000000000a'),
        ('30000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000b', '20000000-0000-4000-8000-00000000000b');

      insert into work_experiences (user_id, employer, title, origin) values
        ('00000000-0000-4000-8000-00000000000a', 'Acme', 'HR Manager', 'cv_upload'),
        ('00000000-0000-4000-8000-00000000000b', 'Globex', 'Payroll lead', 'cv_upload');

      insert into career_facts (user_id, kind, statement, origin) values
        ('00000000-0000-4000-8000-00000000000a', 'responsibility', 'Managed six recruiters', 'cv_upload'),
        ('00000000-0000-4000-8000-00000000000a', 'skill', 'Greenhouse', 'linkedin_import'),
        ('00000000-0000-4000-8000-00000000000a', 'skill', 'Workday', 'conversation'),
        ('00000000-0000-4000-8000-00000000000b', 'achievement', 'Ran payroll for 400 employees', 'cv_upload'),
        ('00000000-0000-4000-8000-00000000000c', 'skill', 'Excel', 'cv_upload');
    `);

    await migrate(drizzle(client), { migrationsFolder: "drizzle" });

    const documents = await rows<Record<string, unknown>>(
      `select id, user_id, kind, file_name, format, file_ref, language, language_confirmed, extracted_text, parse_status, parse_error, version
       from source_documents order by user_id, file_ref`,
    );
    expect(documents).toEqual([
      expect.objectContaining({
        id: "10000000-0000-4000-8000-000000000001",
        kind: "cv",
        file_name: "קורות חיים.pdf",
        format: "pdf",
        file_ref: "tg-he",
        language: "he",
        language_confirmed: false,
        extracted_text: HEBREW_CV,
        parse_status: "parsed",
        parse_error: null,
        version: 1,
      }),
      expect.objectContaining({ id: "10000000-0000-4000-8000-000000000002", kind: "linkedin_export", format: "pdf", language: "en" }),
      expect.objectContaining({
        id: "20000000-0000-4000-8000-00000000000b",
        user_id: "00000000-0000-4000-8000-00000000000b",
        kind: "cv",
        file_name: null,
        format: "other",
        file_ref: "tg-en",
        language: "en",
        extracted_text: ENGLISH_CV,
      }),
      expect.objectContaining({ id: "10000000-0000-4000-8000-000000000004", format: "docx", language: "en", version: 1 }),
      expect.objectContaining({ id: "10000000-0000-4000-8000-000000000005", format: "docx", language: "en", version: 2 }),
    ]);

    expect(await rows(`select id, kind, document_id, content from profile_sources order by id`)).toEqual([
      { id: "10000000-0000-4000-8000-000000000001", kind: "cv", document_id: "10000000-0000-4000-8000-000000000001", content: null },
      {
        id: "10000000-0000-4000-8000-000000000002",
        kind: "linkedin_export",
        document_id: "10000000-0000-4000-8000-000000000002",
        content: null,
      },
      { id: "10000000-0000-4000-8000-000000000003", kind: "pasted_text", document_id: null, content: "I also know Workday" },
      { id: "10000000-0000-4000-8000-000000000004", kind: "cv", document_id: "10000000-0000-4000-8000-000000000004", content: null },
      { id: "10000000-0000-4000-8000-000000000005", kind: "cv", document_id: "10000000-0000-4000-8000-000000000005", content: null },
    ]);

    expect(await rows(`select id, source_document_id from cv_versions order by id`)).toEqual([
      { id: "30000000-0000-4000-8000-00000000000a", source_document_id: "10000000-0000-4000-8000-000000000001" },
      { id: "30000000-0000-4000-8000-00000000000b", source_document_id: "20000000-0000-4000-8000-00000000000b" },
    ]);

    expect(await rows(`select statement, source_document_id from career_facts order by statement`)).toEqual([
      { statement: "Excel", source_document_id: null },
      { statement: "Greenhouse", source_document_id: "10000000-0000-4000-8000-000000000002" },
      { statement: "Managed six recruiters", source_document_id: "10000000-0000-4000-8000-000000000001" },
      { statement: "Ran payroll for 400 employees", source_document_id: "20000000-0000-4000-8000-00000000000b" },
      { statement: "Workday", source_document_id: null },
    ]);
    expect(await rows(`select employer, source_document_id from work_experiences order by employer`)).toEqual([
      { employer: "Acme", source_document_id: "10000000-0000-4000-8000-000000000001" },
      { employer: "Globex", source_document_id: "20000000-0000-4000-8000-00000000000b" },
    ]);

    expect(await rows(`select to_regclass('master_cvs') as table`)).toEqual([{ table: null }]);
  });
});

describe("CV language and formats migration", () => {
  let folder: string;

  beforeEach(async () => {
    await client.close();
    client = new PGlite();
    folder = await migrationsUpTo(LAST_SINGLE_LANGUAGE_CV_MIGRATION);
    await migrate(drizzle(client), { migrationsFolder: folder });
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it("detects each existing version's language and keeps its sent Word document", async () => {
    await client.exec(`
      insert into users (id, telegram_user_id, telegram_chat_id, preferred_language) values
        ('00000000-0000-4000-8000-00000000000a', 1, 1, null),
        ('00000000-0000-4000-8000-00000000000b', 2, 2, 'he');
      insert into career_facts (id, user_id, kind, statement, origin, verification_status, verified_at) values
        ('40000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000a', 'skill', 'Excel', 'cv_upload', 'verified', now()),
        ('40000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000b', 'skill', 'אקסל', 'cv_upload', 'verified', now());
      insert into cv_versions (id, user_id, status, rendered_file_ref) values
        ('30000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000a', 'approved', 'tg-docx'),
        ('30000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000b', 'draft', null),
        ('30000000-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-00000000000b', 'failed', null);
      insert into cv_version_items (cv_version_id, career_fact_id, section, position, generated_text) values
        ('30000000-0000-4000-8000-00000000000a', '40000000-0000-4000-8000-00000000000a', 'skills', 0, 'Excel'),
        ('30000000-0000-4000-8000-00000000000b', '40000000-0000-4000-8000-00000000000b', 'skills', 0, 'מנהלת משאבי אנוש ב-Acme');
    `);

    await migrate(drizzle(client), { migrationsFolder: "drizzle" });

    expect(await rows(`select id, language, language_source from cv_versions order by id`)).toEqual([
      { id: "30000000-0000-4000-8000-00000000000a", language: "en", language_source: null },
      { id: "30000000-0000-4000-8000-00000000000b", language: "he", language_source: null },
      { id: "30000000-0000-4000-8000-00000000000c", language: "he", language_source: null },
    ]);
    expect(await rows(`select cv_version_id, format, file_ref from cv_version_files`)).toEqual([
      { cv_version_id: "30000000-0000-4000-8000-00000000000a", format: "docx", file_ref: "tg-docx" },
    ]);
  });
});
