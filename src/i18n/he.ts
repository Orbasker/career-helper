import type { Strings } from "./en.js";

/** Right-to-left mark: starts a paragraph that opens with a command or Latin text in right-to-left direction. */
export const RLM = "‏";

const count = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);
const joinAnd = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} ו${items.at(-1)}`);

export const he: Strings = {
  languageName: "Hebrew",

  menu: {
    whatsNew: "מה חדש?",
    myProfile: "👤 הפרופיל שלי",
  },

  commands: {
    new: "ההתאמות האחרונות",
    profile: "הפרופיל המקצועי שלך",
    sites: "אתרי הדרושים שאני מחפש בהם",
    connections: "מי מוכר לך בחברות שהותאמו",
    language: "בחירת עברית או אנגלית",
    start: "הגדרת הפרופיל המקצועי",
    help: "מה אני יודע לעשות",
  },

  buttons: {
    details: "פרטים",
    interested: "👍 מעניין אותי",
    interestedChosen: "✅ מעניין אותי",
    notInterested: "👎 לא מעניין",
    notInterestedChosen: "✅ לא מעניין",
    tailorCv: "📝 התאמת קורות חיים",
    somethingElse: "✍️ משהו אחר",
    yes: "✅ כן",
    no: "✖️ לא",
    approve: "✅ אישור",
    discard: "🗑 מחיקה",
    sendDocument: "📄 שליחת המסמך",
    deleteConnections: "🗑 מחיקת אנשי הקשר",
    analyze: "🔍 ניתוח",
    confirmProfile: "✅ אישור הפרופיל",
    apply: "✅ להחיל",
    cancel: "✖️ ביטול",
  },

  messages: {
    languageSaved: "מעולה, מעכשיו נדבר בעברית. אפשר לשנות בכל רגע עם ‎/language.",
    welcomeBack: "טוב לראות אותך שוב! לחצו על <b>מה חדש?</b> כדי לראות את ההתאמות האחרונות, או פשוט כתבו לי מה לשנות בהעדפות.",
    welcomeNew:
      "היי! אני סוכן הקריירה שלך. אמצא משרות שמתאימות לניסיון שלך, כולל תפקידים קרובים, ואעזור להתאים את קורות החיים. נתחיל בבניית הפרופיל המקצועי.",
    askLinkedin: "קודם כול, שלחו לי את <b>הקישור לפרופיל הלינקדאין</b> (למשל linkedin.com/in/your-name), או כתבו <i>דלג</i>.",
    askDocuments: [
      "עכשיו שלחו לי את <b>קורות החיים</b> (PDF,‏ DOCX או TXT).",
      "",
      "לינקדאין לא מאפשר לי לקרוא פרופילים ישירות. כדי לייבא גם אותו, פתחו את הפרופיל בלינקדאין ← <b>עוד</b> ← <b>שמירה כ-PDF</b> ושלחו לי את הקובץ.",
      "",
      "אין מסמכים? אפשר פשוט להדביק או לכתוב תקציר של הניסיון התעסוקתי. כשסיימתם לשלוח, לחצו על <b>ניתוח</b>.",
    ].join("\n"),
    linkedinSaved: "שמרתי את הקישור ללינקדאין ✅",
    linkedinSkipped: "לא נשמר קישור ללינקדאין. אפשר להוסיף אותו אחר כך.",
    documentTooLarge: "הקובץ גדול מדי (עד 10MB). שלחו קובץ PDF,‏ DOCX או TXT קטן יותר.",
    unreadableDocument: "לא הצלחתי לקרוא טקסט מהקובץ. שלחו קובץ PDF,‏ DOCX או TXT (לא תמונה סרוקה), או הדביקו את הטקסט.",
    needSource: "כדי לנתח אני צריך לפחות קובץ קורות חיים, PDF של לינקדאין או תקציר קצר של הניסיון שלך.",
    analyzing: "קורא את המסמכים ובונה את הפרופיל… זה יכול לקחת דקה.",
    analysisFailed: "מצטער, לא הצלחתי לנתח את המסמכים הפעם. לחצו על <b>ניתוח</b> כדי לנסות שוב, או שלחו פרטים נוספים.",
    busy: "אני עדיין עובד על הפרופיל ואשלח הודעה כשיהיה מוכן. אם לא תגיע הודעה תוך כמה דקות, שלחו ‎/start כדי להתחיל מחדש.",
    reviewIntro: "<b>זה מה שחילצתי.</b> בדקו בעיון: שום דבר לא נשמר כעובדה לפני שתאשרו.",
    reviewUpdated: "<b>עודכן.</b> כך נראה הפרופיל עכשיו:",
    reviewOutro:
      "כתבו לי תיקונים במילים שלכם (למשל <i>\"עזבתי את Acme ב-2023\"</i>, <i>\"תמחק את Python מהכישורים\"</i>, <i>\"ניהלתי שם 8 אנשים\"</i>), או לחצו על <b>אישור הפרופיל</b>.",
    onboardingDone:
      "הפרופיל אושר ✅ אתחיל לחפש התאמות ואעדכן כשאמצא משהו מתאים.\n\nאפשר לעדכן את הפרופיל בכל רגע, פשוט כתבו לי, למשל <i>\"גיוס כבר לא מעניין אותי\"</i> או <i>\"תוסיף שהובלתי את הסבת מערכת השכר\"</i>.",
    profileOutro: "כדי לשנות משהו, פשוט כתבו לי במילים שלכם.",
    editProposed: "<b>אלה השינויים שאכניס לפרופיל:</b>",
    editConfirm: "להחיל את השינויים?",
    editApplied: "בוצע, הפרופיל עודכן ✅",
    editCancelled: "בסדר, לא שיניתי כלום.",
    expired: "הפעולה הזו כבר לא זמינה.",
    noChange: "לא מצאתי מה לשנות בפרופיל. כתבו לי מה להוסיף, לתקן או להסיר, למשל <i>\"תוסיף שניהלתי צוות של 5\"</i>.",
    notOnboarded: "בואו נגדיר קודם את הפרופיל המקצועי: שלחו ‎/start.",
    documentNotExpected: "אני מייבא מסמכים רק בזמן בניית הפרופיל. כדי לשנות את הפרופיל, פשוט כתבו לי מה להוסיף או לתקן.",
    noMatches: "אין כרגע התאמות חדשות. אשלח הודעה כשיופיע משהו רלוונטי.",
    matchNotFound: "המשרה הזו כבר לא נמצאת.",
    feedbackInterested: "סומן כמעניין 👍",
    feedbackNotInterested: "הבנתי, אציג פחות משרות כאלה.",
    feedbackReasonPrompt: "מה לא התאים? זה לא חובה, אבל זה עוזר לי ללמוד מה לדלג.",
    feedbackReasonNoted: "רשמתי, תודה.",
    feedbackReasonTextPrompt: "כתבו לי בהודעה אחת מה לא התאים.",
    feedbackReasonTextSaved: "תודה, זה עוזר.",
    proposalAccepted: "בוצע ✅ אשתמש בזה בהתאמות הבאות.",
    proposalRejected: "בסדר, לא אשתמש בזה.",
    cvRequested: "אני מכין קורות חיים מותאמים למשרה הזו. זה לוקח בערך דקה, ואשלח אותם לכאן לבדיקה.",
    cvInProgress: "קורות חיים מותאמים למשרה הזו כבר בהכנה.",
    cvFailed: "מצטער, לא הצלחתי להכין את קורות החיים הפעם. לחצו שוב על <b>התאמת קורות חיים</b> כדי לנסות שוב.",
    cvDraftOutro:
      "כל שורה מגיעה מהפרופיל שאישרתם: רק בחרתי, סידרתי וניסחתי מחדש עבור המשרה הזו. אשרו כדי לשמור את הגרסה, או מחקו אותה.",
    cvApproved: "נשמר ✅ הנה קורות החיים למשרה הזו כקובץ Word.",
    cvDocumentCaption: "קורות החיים המותאמים. כל שורה מגיעה מהפרופיל שאישרתם.",
    cvDocumentFailed: "קורות החיים נשמרו, אבל לא הצלחתי ליצור את הקובץ כרגע. לחצו למטה כדי לנסות שוב.",
    cvDiscarded: "נמחק. לחצו על <b>התאמת קורות חיים</b> במשרה כדי להתחיל מחדש.",
    help: [
      "<b>מה אני יודע לעשות</b>",
      `${RLM}• ‎/new — ההתאמות האחרונות`,
      `${RLM}• ‎/profile — הפרופיל המקצועי שלך`,
      `${RLM}• ‎/sites — אתרי הדרושים שאני מחפש בהם (הוספת אתר: ‎/addsite example.co.il)`,
      `${RLM}• ‎/connections — ייבוא אנשי הקשר מלינקדאין כדי לראות מי מוכר לך בכל חברה`,
      `${RLM}• ‎/language — בחירת עברית או אנגלית`,
      `${RLM}• ‎/start — הגדרת הפרופיל`,
      "• כתבו לי כל דבר כדי לעדכן את הפרופיל (למשל \"עד 40 דקות נסיעה\", \"תוסיף שניהלתי את X\").",
    ].join("\n"),
    error: "משהו השתבש אצלי. נסו שוב בעוד רגע.",
    connectionsHowTo: [
      "<b>ייבוא אנשי הקשר מלינקדאין</b>",
      "אראה לך מי מוכר לך בכל חברה שאתאים לך.",
      "",
      `${RLM}1. בלינקדאין פתחו <b>Settings ← Data privacy ← Get a copy of your data</b>.`,
      `${RLM}2. בחרו <b>Connections</b> ובקשו את הארכיון. לינקדאין שולח אותו במייל תוך כמה דקות.`,
      `${RLM}3. שלחו לי כאן את <b>Connections.csv</b> (או את כל קובץ ה-ZIP).`,
      "",
      "אני משתמש באנשי הקשר רק כדי להציג אותם בהתאמות שלך. אפשר למחוק אותם בכל רגע.",
    ].join("\n"),
    connectionsNotRecognized:
      "הקובץ לא נראה כמו ייצוא אנשי קשר מלינקדאין. שלחו את <b>Connections.csv</b> או את קובץ ה-ZIP, ראו ‎/connections.",
    connectionsEmpty: "לא מצאתי אנשי קשר בקובץ. שלחו ‎/connections כדי לראות איך מייצאים אותם.",
    connectionsDeleted: "מחקתי את אנשי הקשר. אפשר לשלוח ייצוא חדש בכל רגע עם ‎/connections.",
    connectionsNone: "אין לך אנשי קשר מיובאים.",
    noSites:
      "מעבר ללוחות הדרושים של החברות שאני בודק כל יום, אני מחפש ברשת משרות שמתאימות לפרופיל שלך.\n\nהוסיפו את אתרי הדרושים האהובים עליכם ואחפש גם בהם: שלחו <b>‎/addsite</b> ואחריו את האתר, למשל <i>‎/addsite example.co.il</i>.",
    sitesIntro: "<b>אתרי הדרושים שאני מחפש בהם</b>\nאני מחפש גם ברשת הפתוחה ובלוחות הדרושים של החברות שאני בודק כל יום.",
    sitesOutro: "להוספת אתר נוסף שלחו <b>‎/addsite</b> ואחריו את האתר. לחיצה על אתר מסירה אותו.",
    siteUsage: "שלחו <b>‎/addsite</b> ואחריו את האתר, למשל <i>‎/addsite example.co.il</i>.",
    siteInvalid: "זה לא נראה כמו אתר. שלחו משהו כמו <i>‎/addsite example.co.il</i>.",
    siteLimit: "יש לך כבר 20 אתרים, המקסימום שאני יכול לחפש בו. הסירו קודם אתר עם ‎/sites.",
    siteRemoved: "הוסר. לא אחפש יותר באתר הזה.",
    siteBoard: "זה לוח דרושים של חברה, אז הוספתי אותו ללוחות שאני בודק כל יום ✅",
  },

  siteAdded: (domain) => `הוספתי את <b>${domain}</b> ✅ אחפש בו משרות שמתאימות לך בחיפוש היומי הבא.`,
  siteExists: (domain) => `אני כבר מחפש בשבילך ב-<b>${domain}</b>.`,

  languageStatus: (name, chosen) => `🌐 אני מדבר איתך ב<b>${name}</b>${chosen ? "" : " (עוד לא בחרת שפה)"}.\nלחצו על שפה כדי לשנות:`,

  recommendations: {
    strong_fit: "התאמה חזקה",
    good_fit: "התאמה טובה",
    stretch: "אתגר",
    not_recommended: "לא מומלץ",
  },

  feedbackReasons: {
    role: "🧭 לא סוג התפקיד שלי",
    seniority: "📶 רמה לא מתאימה",
    location: "📍 מיקום",
    work_mode: "🏠 מרחוק / מהמשרד",
    company: "🏢 החברה",
    pay: "💰 שכר",
  },

  match: {
    currentEmployer: (employer) =>
      `🏢 <b>הזדמנות פנימית ב-${employer}</b>, מקום העבודה הנוכחי שלך. מעבר פנימי לרוב קל יותר: המוצר והאנשים כבר מוכרים לך, אז כדאי לשאול עליו את המנהל או את משאבי האנוש.`,
    formerEmployer: (employer) => `↩️ <b>עבדת בעבר ב-${employer}.</b> זה יתרון: כדאי לציין את זה ולפנות לעמיתים לשעבר שם.`,
    connections: (n, company) => `👥 ${count(n, "איש קשר אחד", "אנשי קשר")} ב-${company}`,
    contactsHeading: (company) => `<b>אנשים שמוכרים לך ב-${company}</b>`,
    contactsMore: (n) => `<i>ועוד ${n}</i>`,
    contactsStale: (month) => `<i>מתוך ייצוא הלינקדאין מ-${month}. שלחו ‎/connections כדי לרענן.</i>`,
    whyItFits: "למה זה מתאים",
    transferableSkills: "כישורים שעוברים איתך",
    gaps: "פערים",
    openPosting: "למודעה המקורית",
  },

  digest: {
    heading: (n) => `<b>${count(n, "התאמה חדשה אחת", "התאמות חדשות")} בשבילך</b>`,
    more: (n, button) => `<i>ועוד ${n}. לחצו על <b>${button}</b> כדי לראות אותן.</i>`,
  },

  proposal: {
    dislike: (label) => `לדלג מעכשיו על ${label}?`,
    mustHave: (label) => `להפוך את ${label} לדרישת חובה?`,
    add: (label, section) => `להוסיף את ${label} ל${section}?`,
  },

  cv: {
    title: (job, company) => `<b>📝 קורות חיים מותאמים ל-${job}${company ? ` ב-${company}` : ""}</b>`,
    summary: "תקציר",
    skills: "כישורים",
    education: "השכלה",
    certifications: "הסמכות",
    languages: "שפות",
    other: "נוסף",
    applicationNote: "מכתב מקדים",
  },

  connections: {
    imported: (contacts, companies, skipped) =>
      `ייבאתי ${count(contacts, "איש קשר אחד", "אנשי קשר")} ב${count(companies, "חברה אחת", "חברות")} ✅${
        skipped ? ` (דילגתי על ${count(skipped, "שורה אחת", "שורות")} בלי שם)` : ""
      }\nאראה לך את מי מוכר לך כשאתאים לך משרה באחת החברות שלהם.`,
    summary: (contacts, companies, date) =>
      `<b>אנשי הקשר שלך</b>\n${count(contacts, "איש קשר אחד", "אנשי קשר")} ב${count(companies, "חברה אחת", "חברות")}, יובאו ב-${date}.\n\nאפשר לשלוח בכל רגע Connections.csv חדש יותר כדי להחליף אותם.`,
  },

  onboarding: {
    sourceReceived: (source, fileName) =>
      `קיבלתי את ${source}${fileName ? ` (${fileName})` : ""} ✅ אפשר לשלוח עוד, או ללחוץ על <b>ניתוח</b> כשסיימתם.`,
    question: (position, total, text) => `<i>שאלה ${position} מתוך ${total}</i>\n${text}\n\n<i>אפשר לכתוב "דלג" כדי לדלג.</i>`,
  },

  sources: {
    cv: "קורות החיים",
    linkedin_export: "ייצוא הלינקדאין",
    pasted_text: "ההערות שלך",
  },

  profile: {
    seniority: (level) => `דרג: ${level}`,
    managementScope: (scope) => `היקף ניהול: ${scope}`,
    openToAdjacent: (open) => `פתיחות לתפקידים קרובים: ${open ? "כן" : "לא"}`,
    linkedin: (url) => `לינקדאין: ${url}`,
    experience: "ניסיון",
    managed: (n) => `ניהול ${n} אנשים`,
    present: "היום",
    factSections: {
      skill: "כישורים",
      education: "השכלה",
      certification: "הסמכות",
      language: "שפות",
      responsibility: "ניסיון נוסף",
      achievement: "הישגים",
      other: "נוסף",
    },
    preferenceSections: {
      target_role: "תפקידי יעד",
      hard_constraint: "דרישות חובה",
      soft_preference: "העדפות",
      dislike: "להימנע",
    },
  },

  seniority: {
    entry: "התחלתי",
    junior: "ג'וניור",
    mid: "ביניים",
    senior: "סניור",
    lead: "מוביל/ת",
    manager: "מנהל/ת",
    director: "דירקטור/ית",
    executive: "הנהלה בכירה",
  },

  workModes: {
    onsite: "מהמשרד",
    hybrid: "היברידי",
    remote: "מרחוק",
  },

  changes: {
    profile: "פרופיל",
    role: "תפקיד",
    roleAt: (title, employer) => `${title} ב-${employer}`,
    unknownRole: "תפקיד לא ידוע",
    unknownFact: "פרט לא ידוע",
    unknownPreference: "העדפה לא ידועה",
    replaces: (label) => `(במקום “${label}”)`,
    yes: "כן",
    no: "לא",
    factKinds: {
      responsibility: "תחום אחריות",
      achievement: "הישג",
      skill: "כישור",
      education: "השכלה",
      certification: "הסמכה",
      language: "שפה",
      other: "פרט",
    },
    preferenceKinds: {
      target_role: "תפקיד יעד",
      hard_constraint: "דרישת חובה",
      soft_preference: "העדפה",
      dislike: "להימנע",
    },
    profileFields: {
      headline: "כותרת",
      summary: "תקציר",
      currentSeniority: "דרג",
      managementScope: "היקף ניהול",
      openToAdjacentRoles: "פתיחות לתפקידים קרובים",
    },
    experienceFields: {
      employer: "מעסיק",
      title: "תפקיד",
      industry: "תעשייה",
      location: "מיקום",
      seniority: "דרג",
      managedHeadcount: "מספר מנוהלים",
      startDate: "התחלה",
      endDate: "סיום",
      isCurrent: "תפקיד נוכחי",
    },
  },

  learning: {
    roleLabel: (word) => `תפקידי ${word}`,
    roleRationale: (n, word) => `דילגת על ${n} משרות עם “${word}” בכותרת.`,
    companyLabel: (company) => `משרות ב-${company}`,
    companyRationale: (n, company) => `דילגת על ${n} משרות ב-${company} בגלל החברה.`,
    workModeLabel: (modes) => `רק ${modes.join(" או ")}`,
    workModeRationale: (n, modes) => `דילגת על ${n} משרות ${joinAnd(modes)} בגלל מתכונת העבודה.`,
  },

  matching: {
    mustHaveConflict: (label) => `המשרה הזו מתנגשת בדרישת החובה שלך: ${label}.`,
    dislikeConflict: (label) => `זה נראה כמו סוג התפקיד שביקשת להימנע ממנו: ${label}.`,
    outsidePath: "התפקיד הזה מחוץ לתפקידים שמעניינים אותך, וביקשת לדלג על תפקידים קרובים.",
    notBuilding: "התפקיד הזה לא נשען מספיק על הניסיון המוכח שלך.",
  },
};
