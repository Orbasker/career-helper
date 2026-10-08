import type {
  ApplicationEventSource,
  ApplicationStatus,
  CareerFactKind,
  ConversationLanguage,
  CvLanguageSource,
  DocumentKind,
  MatchRecommendation,
  PreferenceKind,
  ProfileSourceKind,
  SeniorityLevel,
  WorkMode,
} from "../domain/enums.js";
import type { ExperienceFields, ProfileFields } from "../domain/profile.js";
import type { JobLinkOutcome } from "../app/services.js";
import type { FeedbackReasonTag } from "../learning/infer.js";

const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);
const joinAnd = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

export const en = {
  /** How prompts name this language when asking a model to answer in it. */
  languageName: "English",

  menu: {
    whatsNew: "What's new?",
    myProfile: "👤 My profile",
  },

  commands: {
    new: "Latest job matches",
    profile: "Your career profile",
    cvs: "Your CVs and the default for each language",
    applications: "Jobs you applied to and where they stand",
    search: "Search for jobs now",
    sources: "Where I search for jobs",
    sites: "Job sites I search for you",
    connections: "Who you know at matched companies",
    language: "Choose English or Hebrew",
    start: "Set up your career profile",
    help: "What I can do",
  },

  buttons: {
    details: "Details",
    interested: "👍 Interested",
    interestedChosen: "✅ Interested",
    notInterested: "👎 Not interested",
    notInterestedChosen: "✅ Not interested",
    tailorCv: "📝 Tailor my CV",
    originalPosting: "🔗 Original posting",
    somethingElse: "✍️ Something else",
    yes: "✅ Yes",
    no: "✖️ No",
    approve: "✅ Approve",
    discard: "🗑 Discard",
    sendDocument: "📄 Send document",
    pdf: "📕 PDF",
    word: "📝 Word",
    cvInLanguage: (language: string) => `🌐 ${language} version`,
    deleteConnections: "🗑 Delete my connections",
    analyze: "🔍 Analyze",
    showBoards: "🏢 Show boards",
    manageSites: "⭐ Manage my sites",
    addSite: "⭐ Add a site",
    confirmProfile: "✅ Confirm profile",
    apply: "✅ Apply",
    cancel: "✖️ Cancel",
    myCvs: "📄 My CVs",
    addCv: "➕ Add a CV",
    makeDefault: (language: string) => `⭐ Make default for ${language}`,
    rename: "✏️ Rename",
    replace: "🔁 Replace",
    remove: "🗑 Remove",
    confirmRemove: "🗑 Yes, remove it",
    keep: "✖️ Keep it",
    applied: "📨 I applied",
    appliedStatus: (status: string) => `📌 Applied · ${status}`,
    appliedWithCv: "📨 I applied with this CV",
    myApplications: "📨 My applications",
    logApplication: "➕ Log an application",
    addNote: "📝 Add a note",
  },

  messages: {
    languageSaved: "Got it, I'll talk to you in English. Change it anytime with /language.",
    welcomeBack:
      "Welcome back! Tap <b>What's new?</b> for your latest matches, or just tell me what you'd like to change in your preferences.",
    welcomeNew:
      "Hi! I'm your career agent. I'll find jobs that fit your experience — including adjacent roles — and help tailor your CV. Let's build your career profile first.",
    askLinkedin: "First, send me your <b>LinkedIn profile URL</b> (e.g. linkedin.com/in/your-name), or reply <i>skip</i>.",
    askDocuments: [
      "Now send me your <b>CV / resume</b> (PDF, DOCX or TXT). Have it in more than one language, e.g. Hebrew and English? Send each one.",
      "",
      "LinkedIn doesn't let me read profiles directly. To import yours too, open your LinkedIn profile → <b>More</b> → <b>Save to PDF</b> and send me that file.",
      "",
      "No documents? Just paste or type a summary of your work history. Tap <b>Analyze</b> when you've sent everything.",
    ].join("\n"),
    linkedinSaved: "Saved your LinkedIn URL ✅",
    linkedinSkipped: "No LinkedIn URL saved — you can add it later.",
    documentTooLarge: "That file is too large (max 10 MB). Please send a smaller PDF, DOCX or TXT file.",
    unreadableDocument:
      "I couldn't read text from that file. Please send a PDF, DOCX or TXT file (not a scanned image), or paste the text.",
    legacyDoc:
      "I can't read old Word <b>.doc</b> files. In Word choose <b>File → Save As → Word Document (.docx)</b> or <b>PDF</b>, and send me that file.",
    needSource:
      "I need at least one CV, LinkedIn PDF or a short written summary of your experience before I can analyze it.",
    analyzing: "Reading your documents and building your profile… this can take a minute.",
    analysisFailed: "Sorry, I couldn't analyze your documents this time. Tap <b>Analyze</b> to try again, or send more details.",
    busy: "I'm still working on your profile — I'll message you when it's ready. If nothing arrives in a few minutes, send /start to begin again.",
    reviewIntro: "<b>Here's what I extracted.</b> Please check it carefully — nothing is saved as fact until you confirm.",
    reviewUpdated: "<b>Updated.</b> Here's your profile now:",
    reviewOutro:
      "Reply with any corrections in your own words (e.g. <i>\"I left Acme in 2023\"</i>, <i>\"remove the Python skill\"</i>, <i>\"I managed 8 people there\"</i>), or tap <b>Confirm profile</b>.",
    onboardingDone:
      "Your profile is confirmed ✅ I'll start looking for matches and let you know when something fits.\n\nYou can update your profile anytime — just tell me, e.g. <i>\"I'm no longer interested in recruiting roles\"</i> or <i>\"add that I managed the payroll migration\"</i>.",
    profileOutro: "To change anything, just tell me in your own words.",
    editProposed: "<b>I'll make these changes to your profile:</b>",
    editConfirm: "Apply these changes?",
    editApplied: "Done — your profile is updated ✅",
    editCancelled: "OK, nothing changed.",
    expired: "That action is no longer available.",
    noChange:
      "I didn't find anything to change in your profile. Tell me what to add, correct or remove — e.g. <i>\"add that I managed a team of 5\"</i>.",
    notOnboarded: "Let's set up your career profile first — send /start.",
    documentNotExpected:
      "I can't take documents at this step. Finish setting up your profile first (or send /start), then send it again.",
    documentNothingNew: "Your profile already covers everything in this document, so there's nothing to change.",
    documentMergeFailed:
      "I saved the file, but couldn't compare it with your profile right now. Tell me what to add in your own words, or send it again later.",
    noMatches: "No new matches right now. I'll message you when something relevant shows up.",
    matchNotFound: "I couldn't find that job anymore.",
    feedbackInterested: "Marked as interested 👍",
    feedbackNotInterested: "Got it, I'll show fewer jobs like this.",
    feedbackReasonPrompt: "What put you off? It's optional, but it helps me learn what to skip.",
    feedbackReasonNoted: "Noted, thanks.",
    feedbackReasonTextPrompt: "Tell me in one message what put you off.",
    feedbackReasonTextSaved: "Thanks, that helps.",
    proposalAccepted: "Done ✅ I'll use this for new matches.",
    proposalRejected: "OK, I won't use that.",
    cvRequested: "I'm preparing a tailored CV for this job. It takes about a minute; I'll send it here for your review.",
    cvInProgress: "A tailored CV for this job is already being prepared.",
    cvFailed: "Sorry, I couldn't prepare the CV this time. Tap <b>Tailor my CV</b> again to retry.",
    cvDraftOutro:
      "Every line comes from your confirmed profile: I only chose, ordered and reworded it for this job. Approve to keep this version, or discard it.",
    cvLanguageRequested: (language: string) =>
      `I'm preparing the ${language} version, keeping the same highlights. It takes about a minute; I'll send it here for your review.`,
    cvApproved: "Saved ✅ Here's your CV for this job as a Word document. Tap below for a PDF or another language.",
    cvDocumentCaption: "Your tailored CV. Every line comes from your confirmed profile.",
    cvDocumentFailed: "Your CV is saved, but I couldn't create the document right now. Tap below to try again.",
    cvDiscarded: "Discarded. Tap <b>Tailor my CV</b> on the job to start over.",
    help: [
      "<b>What I can do</b>",
      "• /new — your latest matches",
      "• /profile — your career profile",
      "• Send an updated CV (PDF, DOCX or TXT) anytime — I'll show what it adds to your profile before saving anything.",
      "• /cvs — your CVs: rename, replace or remove them, and choose the default for each language",
      "• /applications — jobs you applied to: update where each one stands or add notes. Log one I didn't find with /applied",
      "• /search — search every job site and the web for you right now (I also search for you twice a day). Add words to look for something specific, e.g. <i>/search product manager</i>",
      "• /sources — where I search for jobs and what I found there",
      "• /sites — job sites I search for you (add one with /addsite example.co.il)",
      "• /connections — import your LinkedIn connections to see who you know at each company",
      "• Send me a link to a job posting and I'll tell you how well it fits you.",
      "• /language — choose English or Hebrew",
      "• /start — set up your profile",
      "• Tell me anything to update your profile (e.g. \"no more than 40 minutes commute\", \"add that I managed X\").",
    ].join("\n"),
    error: "Something went wrong on my side. Please try again in a moment.",
    connectionsHowTo: [
      "<b>Import your LinkedIn connections</b>",
      "I'll show you who you know at each company I match you with.",
      "",
      "1. On LinkedIn open <b>Settings → Data privacy → Get a copy of your data</b>.",
      "2. Choose <b>Connections</b> and request the archive. LinkedIn emails it within minutes.",
      "3. Send me <b>Connections.csv</b> (or the whole ZIP) here.",
      "",
      "I only use your contacts to show them on your own matches. You can delete them any time.",
    ].join("\n"),
    connectionsNotRecognized:
      "That file doesn't look like a LinkedIn connections export. Send <b>Connections.csv</b> or the export ZIP — see /connections.",
    connectionsEmpty: "I couldn't find any contacts in that file. Send /connections for how to export them.",
    connectionsDeleted: "Deleted your contacts. Send a new export any time with /connections.",
    connectionsNone: "You have no imported contacts.",
    noSites:
      "Besides the company job boards I check every day, I search the web for jobs that fit your profile.\n\nAdd your favourite job sites and I'll search them too: send <b>/addsite</b> followed by the site, e.g. <i>/addsite example.co.il</i>.",
    sitesIntro: "<b>Job sites I search for you</b>\nI also search the open web and the company job boards I check every day.",
    sitesOutro: "Add another with <b>/addsite</b> followed by the site. Tap a site to remove it.",
    siteUsage: "Send <b>/addsite</b> followed by the site, e.g. <i>/addsite example.co.il</i>.",
    siteInvalid: "That doesn't look like a website. Send something like <i>/addsite example.co.il</i>.",
    siteLimit: "You already have 20 sites, the most I can search. Remove one with /sites first.",
    siteRemoved: "Removed. I won't search that site anymore.",
    siteBoard: "That's a company job board, so I added it to the boards I check every day ✅",
  },

  siteAdded: (domain: string) => `Added <b>${domain}</b> ✅ I'll search it for jobs that fit you in my next daily search.`,
  siteExists: (domain: string) => `I'm already searching <b>${domain}</b> for you.`,

  languageStatus: (name: string, chosen: boolean) =>
    `🌐 I talk to you in <b>${name}</b>${chosen ? "" : " (you haven't chosen one yet)"}.\nTap a language to change it:`,

  recommendations: {
    strong_fit: "Strong fit",
    good_fit: "Good fit",
    stretch: "Stretch",
    not_recommended: "Not recommended",
  } satisfies Record<MatchRecommendation, string>,

  feedbackReasons: {
    role: "🧭 Not my kind of role",
    seniority: "📶 Wrong level",
    location: "📍 Location",
    work_mode: "🏠 Remote / office setup",
    company: "🏢 Company",
    pay: "💰 Pay",
  } satisfies Record<FeedbackReasonTag, string>,

  match: {
    currentEmployer: (employer: string) =>
      `🏢 <b>Internal opportunity at ${employer}</b>, where you work today. Internal moves are often easier: you already know the product and the people, so ask your manager or HR about it.`,
    formerEmployer: (employer: string) =>
      `↩️ <b>You worked at ${employer} before.</b> That's an advantage: mention it, and reach out to former colleagues there.`,
    connections: (count: number, company: string) => `👥 ${plural(count, "connection", "connections")} at ${company}`,
    contactsHeading: (company: string) => `<b>People you know at ${company}</b>`,
    contactsMore: (count: number) => `<i>and ${count} more</i>`,
    contactsStale: (month: string) => `<i>From your LinkedIn export of ${month}. Send /connections to refresh it.</i>`,
    whyItFits: "Why it fits",
    transferableSkills: "Transferable skills",
    gaps: "Gaps",
    openPosting: "Open original posting",
  },

  digest: {
    heading: (count: number) => `<b>${plural(count, "new job match", "new job matches")} for you</b>`,
    more: (count: number, button: string) => `<i>+${count} more — tap <b>${button}</b> to see them.</i>`,
  },

  proposal: {
    dislike: (label: string) => `Should I skip ${label} from now on?`,
    mustHave: (label: string) => `Should I make ${label} a must-have?`,
    add: (label: string, section: string) => `Should I add ${label} to your ${section.toLowerCase()}?`,
  },

  cv: {
    title: (job: string, company: string | null) => `<b>📝 Tailored CV for ${job}${company ? ` at ${company}` : ""}</b>`,
    language: (language: string, reason: string | null) => `🌐 ${language}${reason ? ` (${reason})` : ""}`,
    languageReasons: {
      requested: "as you asked",
      job: "the language of the job posting",
      cv: "the language of your CV",
      conversation: "the language we chat in",
    } satisfies Record<CvLanguageSource, string>,
    summary: "Summary",
    skills: "Skills",
    education: "Education",
    certifications: "Certifications",
    languages: "Languages",
    other: "Other",
    applicationNote: "Application note",
  },

  connections: {
    imported: (contacts: number, companies: number, skipped: number) =>
      `Imported ${plural(contacts, "contact", "contacts")} at ${plural(companies, "company", "companies")} ✅${
        skipped ? ` (${skipped} rows without a name were skipped)` : ""
      }\nI'll show who you know when I match you with one of their companies.`,
    summary: (contacts: number, companies: number, date: string) =>
      `<b>Your connections</b>\n${plural(contacts, "contact", "contacts")} at ${plural(companies, "company", "companies")}, imported ${date}.\n\nSend a newer Connections.csv any time to replace them.`,
  },

  jobLinks: {
    reading: "🔎 Reading the job posting and checking how it fits you. This can take up to a minute.",
    readingOneOf: (host: string) => `🔎 Reading the job at <b>${host}</b>…`,
    known: "I already had this job. Here's how it fits you:",
    fits: "Here's how this job fits you:",
    failsMustHave:
      "⚠️ This job breaks one of your must-haves, so I didn't evaluate it further. If that must-have has changed, just tell me.",
    connectionsTip: (company: string) => `<i>Send /connections to see who you know at ${company}.</i>`,
    failures: {
      invalid: "That link doesn't look like a public web page I can open.",
      inaccessible:
        "I couldn't open that page: the site may be down or may not allow automated reading. Try again later, or send a link to the same job on the company's careers page.",
      login_required:
        "That page needs a login, so I can't read it. Send a link to the same job on the company's careers page or another public job site.",
      gone: "That page no longer exists, so the job was probably taken down.",
      closed: "That posting is closed or expired, so I didn't evaluate it.",
      not_a_job:
        "I couldn't find a single open job posting on that page. Send the link to the posting itself, not a list of jobs or a company page.",
      unavailable: "I can't read job links right now. Please try again later.",
      evaluation_failed: "I saved the job but couldn't evaluate it right now. I'll include it in my next daily check.",
    } satisfies Record<Exclude<JobLinkOutcome["kind"], "evaluated" | "fails_must_have" | "not_onboarded">, string>,
  },

  documentLanguages: { en: "English", he: "Hebrew" } satisfies Record<ConversationLanguage, string>,

  documents: {
    languageButton: (language: string, detected: boolean) => `🌐 ${detected ? `It's ${language}` : language}`,
    languageMarked: (language: string) => `Marked as ${language} ✅`,
    saved: (source: string, fileName: string | null, language: string | null, version: number) =>
      `Saved ${source}${fileName ? ` (${fileName})` : ""}${language ? ` · ${language}` : ""}${
        version > 1 ? ` · version ${version}` : ""
      } ✅ Your earlier documents are kept too.`,
    replaced: (source: string, fileName: string | null, language: string | null, replaced: string) =>
      `Saved ${source}${fileName ? ` (${fileName})` : ""}${language ? ` · ${language}` : ""} ✅ It replaces <b>${replaced}</b>, which I've removed from your CVs. Facts already in your profile stay.`,
  },

  jobSources: {
    title: "<b>Where I search for jobs</b>",
    boardsHeading: "🏢 <b>Company job boards</b>",
    boards: (count: number, perSource: string, collected: string | null) =>
      `${plural(count, "official board", "official boards")} (${perSource}), checked every day. ${
        collected ? `Last collected ${collected}.` : "Not collected yet."
      }`,
    noBoards: "No company boards yet. Board links I find on the web are added here automatically.",
    jobSitesHeading: "🔎 <b>Job sites</b>",
    jobSites: (names: string, searched: string | null) =>
      `${names}: searched with your roles every day and whenever you send /search. ${
        searched ? `Last searched ${searched}.` : "Not searched yet."
      }`,
    webHeading: "🌐 <b>Web search</b>",
    web: (enabled: boolean, searched: string | null) =>
      `I search the open web for postings that fit your profile. ${
        !enabled ? "Turned off right now." : searched ? `Last searched for you ${searched}.` : "Not searched for you yet."
      }`,
    sitesHeading: "⭐ <b>Your sites</b>",
    noSites: "None yet. Add one with <i>/addsite example.co.il</i> and I'll search it too.",
    sites: (domains: string) => `${domains}, searched together with the web search.`,
    coverage: (days: number, jobs: number, companies: number) =>
      `New in the last ${days} days: ${plural(jobs, "job", "jobs")}, ${companies} new ${companies === 1 ? "company" : "companies"}.`,
    problems: "⚠️ <b>Problems</b>",
    detailsHint: "<i>A job's Details show where I found it.</i>",
    turnedOff: (source: string) => `${source} is turned off right now.`,
    blocked: (source: string) => `${source} blocked my last search. I'll try again in the next run.`,
    unreachableBoards: (source: string, count: number, boards: string) =>
      `${source}: couldn't reach ${plural(count, "board", "boards")} in the last run (${boards}).`,
    collectionFailed: (source: string) => `${source}: the last collection failed. I'll retry in the next daily run.`,
    searchFailed: "The last web search failed. I'll retry in the next daily run.",
    userSearchFailed: "My last web search for you failed. I'll retry in the next daily run.",
    andMore: (count: number) => ` and ${count} more`,
    boardsListHeading: "<b>Company job boards I check every day</b>",
    boardsTurnedOff: " — turned off",
    noBoardsChecked: "I don't check any company job boards yet.",
  },

  search: {
    started: (keywords: string | null) =>
      `🔎 Searching job sites and the web for ${keywords ? `<b>${keywords}</b>` : "jobs that fit your profile"}. It takes a few minutes; I'll send what I find here.`,
    running: "I'm already searching for you. I'll send the results here when it's done.",
    failed: "Sorry, the search failed. Try again in a little while.",
    doneHeading: "<b>Search done</b>",
    source: (name: string, listed: number, added: number) => `• ${name}: ${plural(listed, "posting", "postings")}, ${added} new`,
    sourceBlocked: (name: string) => `• ${name}: blocked my search this time`,
    sourceFailed: (name: string) => `• ${name}: didn't answer this time`,
    web: (postings: number) => `• Web search: ${plural(postings, "new posting", "new postings")}`,
    matches: (n: number) => (n === 1 ? "Here's a match that fits you:" : `Here are ${n} matches that fit you:`),
    noMatches: "No new matches that fit you this time.",
    remaining: (n: number) => `${plural(n, "more match", "more matches")} in /new.`,
    pending: (n: number) => `I'm still assessing ${plural(n, "job", "jobs")}; good ones arrive in your next digest.`,
  },

  provenance: {
    heading: "<b>Where I found it</b>",
    board: (source: string) => `🏢 Official company job board (${source})`,
    jobSite: (source: string) => `🔎 ${source}`,
    user_site: "⭐ One of your saved sites",
    web_search: "🌐 My web search",
    user_link: "🔗 A link you sent me",
    firstSeen: (origin: string, day: string) => `${origin} · first seen ${day}`,
    alsoPostedOn: (links: string) => `Also posted on ${links}`,
  },

  timeAgo: {
    justNow: "just now",
    minutes: (n: number) => `${n} min ago`,
    hours: (n: number) => `${n}h ago`,
    yesterday: "yesterday",
    days: (n: number) => `${n} days ago`,
  },

  onboarding: {
    sourceReceived: (source: string, fileName: string | null, language: string | null = null) =>
      `Got ${source}${fileName ? ` (${fileName})` : ""}${language ? ` · ${language}` : ""} ✅ Send more, or tap <b>Analyze</b> when you're done.`,
    question: (position: number, total: number, text: string) =>
      `<i>Question ${position} of ${total}</i>\n${text}\n\n<i>Reply "skip" to skip.</i>`,
  },

  cvs: {
    title: "<b>📄 Your CVs</b>",
    empty: "You haven't sent me a CV yet. Send one here (PDF, DOCX or TXT) and I'll add it.",
    outro:
      "Tap a CV to rename, replace or remove it, or to make it the default for its language. To add another, just send the file here.",
    item: (position: number, name: string) => `${position}. <b>${name}</b>`,
    cardTitle: (name: string) => `📄 <b>${name}</b>`,
    kinds: { cv: "CV", linkedin_export: "LinkedIn export" } satisfies Record<DocumentKind, string>,
    unnamed: "Document",
    otherFormat: "other file type",
    languageUnknown: "language unknown",
    detected: "detected",
    version: (n: number) => `version ${n}`,
    added: (day: string) => `added ${day}`,
    defaultFor: (language: string) => `⭐ Default for ${language}`,
    defaultExplained: (language: string) => `I use it when I tailor your CV for jobs in ${language}.`,
    failures: {
      legacy: "⚠️ I couldn't read it: it's an old Word .doc file. Replace it with a DOCX or PDF.",
      unsupported: "⚠️ I couldn't read it: I can only read PDF, DOCX and TXT files.",
      failed: "⚠️ I couldn't find any text in it (is it a scanned image?). Replace it with a PDF, DOCX or TXT that has text.",
    },
    facts: (n: number) =>
      n === 0
        ? "None of the confirmed facts in your profile came from it."
        : `${plural(n, "confirmed fact", "confirmed facts")} in your profile came from it.`,
    defaultSet: (name: string, language: string) =>
      `⭐ <b>${name}</b> is now your default ${language} CV. I'll use it when I tailor your CV for jobs in ${language}.`,
    notEligible: "Only a readable CV with a known language can be a default.",
    chooseDefault: (language: string | null) =>
      language ? `You have several ${language} CVs. Which one should be the default?` : "Which CV should be the default for its language?",
    noCvs: (language: string | null) =>
      language
        ? `You don't have a ${language} CV yet. Send me one here and I'll add it.`
        : "You don't have a readable CV yet. Send me one here and I'll add it.",
    labelPrompt: (name: string) => `What should I call <b>${name}</b>? Send the new name, e.g. <i>Product manager CV</i>.`,
    labelSaved: (name: string) => `Renamed to <b>${name}</b> ✅`,
    replacePrompt: (name: string) =>
      `Send me the file to replace <b>${name}</b>. Facts already in your profile stay as they are, and I'll show you what the new file adds before changing anything.`,
    removeConfirm: (name: string, facts: number) =>
      `Remove <b>${name}</b>?${
        facts ? ` The ${plural(facts, "fact", "facts")} it added to your profile will stay — tell me if any of them should go.` : ""
      } Your other CVs and the rest of your profile won't change.`,
    removed: (name: string) => `Removed <b>${name}</b> from your CVs. Your profile hasn't changed.`,
    uploadHowTo:
      "Send me the CV here as a PDF, DOCX or TXT file. Add a caption to name it, e.g. <i>Product manager CV</i>. I'll detect its language and show you what it adds to your profile.",
    askLanguage: "I'm not sure which language this CV is in. Which is it?",
  },

  applications: {
    title: "<b>📨 Your applications</b>",
    empty:
      "You haven't logged any applications yet. Tap <b>📨 I applied</b> on a job, or log one you found elsewhere with the button below.",
    outro: "Tap an application to update its status or add a note. Applied somewhere I didn't find? Tap <b>Log an application</b>.",
    group: (status: string, n: number) => `<b>${status}</b> (${n})`,
    item: (position: number, title: string, company: string | null, day: string) =>
      `${position}. <b>${title}</b>${company ? ` — ${company}` : ""} · applied ${day}`,
    statuses: {
      applied: "📨 Applied",
      screening: "📞 Screening",
      interviewing: "🗣 Interviewing",
      offer: "🎉 Offer",
      rejected: "✖️ Rejected",
      withdrawn: "↩️ Withdrawn",
      no_response: "🔇 No response",
    } satisfies Record<ApplicationStatus, string>,
    cardTitle: (title: string, company: string | null) => `📨 <b>${title}</b>${company ? ` — ${company}` : ""}`,
    status: (status: string, updated: string) => `Status: <b>${status}</b> · updated ${updated}`,
    appliedOn: (day: string, cvLanguage: string | null) =>
      `Applied ${day}${cvLanguage ? ` with your tailored ${cvLanguage} CV` : ""}`,
    openPosting: "Open the posting",
    history: "<b>History</b>",
    eventApplied: (day: string) => `${day} · Applied`,
    eventStatus: (day: string, from: string, to: string) => `${day} · ${from} → ${to}`,
    eventNote: (day: string, note: string) => `${day} · 📝 ${note}`,
    eventCv: (day: string, language: string | null) => `${day} · 📄 Linked your tailored ${language ? `${language} ` : ""}CV`,
    eventSources: { user: "", email: " (from your email)", system: " (automatically)" } satisfies Record<ApplicationEventSource, string>,
    cardOutro: "Tap the new status when something changes.",
    created: (title: string) =>
      `Recorded ✅ I'll keep track of your application to <b>${title}</b> and won't suggest this job again.`,
    exists: (title: string) => `You already logged your application to <b>${title}</b>. Here's where it stands:`,
    statusChanged: (status: string) => `Updated: ${status}`,
    statusUnchanged: "That's already its status.",
    logPrompt:
      "Which job did you apply to? Send the link to the posting, or the company and the job title, e.g. <i>Acme — HR Manager</i>.",
    logInvalid:
      "I couldn't tell the company and the job title apart. Send them like <i>Acme — HR Manager</i>, or send the link to the posting.",
    logLinkFailed:
      "To log it anyway, send the company and the job title together with the link, e.g. <i>Acme — HR Manager https://…</i>.",
    notePrompt: (title: string) =>
      `Send me your note on <b>${title}</b>, e.g. <i>Spoke with the recruiter, interview on Monday</i>.`,
    noteSaved: "Note saved ✅",
  },

  sources: {
    cv: "your CV",
    linkedin_export: "your LinkedIn export",
    pasted_text: "your notes",
  } satisfies Record<ProfileSourceKind, string>,

  profile: {
    seniority: (level: string) => `Seniority: ${level}`,
    managementScope: (scope: string) => `Management scope: ${scope}`,
    openToAdjacent: (open: boolean) => `Open to adjacent roles: ${open ? "yes" : "no"}`,
    linkedin: (url: string) => `LinkedIn: ${url}`,
    experience: "Experience",
    managed: (count: number) => `managed ${count}`,
    present: "present",
    factSections: {
      skill: "Skills",
      education: "Education",
      certification: "Certifications",
      language: "Languages",
      responsibility: "Other experience",
      achievement: "Achievements",
      other: "Other",
    } satisfies Record<CareerFactKind, string>,
    preferenceSections: {
      target_role: "Target roles",
      hard_constraint: "Must-haves",
      soft_preference: "Nice-to-haves",
      dislike: "Avoid",
    } satisfies Record<PreferenceKind, string>,
  },

  seniority: {
    entry: "Entry",
    junior: "Junior",
    mid: "Mid",
    senior: "Senior",
    lead: "Lead",
    manager: "Manager",
    director: "Director",
    executive: "Executive",
  } satisfies Record<SeniorityLevel, string>,

  workModes: {
    onsite: "onsite",
    hybrid: "hybrid",
    remote: "remote",
  } satisfies Record<WorkMode, string>,

  changes: {
    profile: "Profile",
    role: "Role",
    roleAt: (title: string, employer: string) => `${title} at ${employer}`,
    unknownRole: "unknown role",
    unknownFact: "unknown fact",
    unknownPreference: "unknown preference",
    replaces: (label: string) => `(replaces “${label}”)`,
    yes: "yes",
    no: "no",
    factKinds: {
      responsibility: "responsibility",
      achievement: "achievement",
      skill: "skill",
      education: "education",
      certification: "certification",
      language: "language",
      other: "fact",
    } satisfies Record<CareerFactKind, string>,
    preferenceKinds: {
      target_role: "target role",
      hard_constraint: "must-have",
      soft_preference: "nice-to-have",
      dislike: "avoid",
    } satisfies Record<PreferenceKind, string>,
    profileFields: {
      headline: "headline",
      summary: "summary",
      currentSeniority: "seniority",
      managementScope: "management scope",
      openToAdjacentRoles: "open to adjacent roles",
    } satisfies Record<keyof ProfileFields, string>,
    experienceFields: {
      employer: "employer",
      title: "title",
      industry: "industry",
      location: "location",
      seniority: "seniority",
      managedHeadcount: "people managed",
      startDate: "start",
      endDate: "end",
      isCurrent: "current role",
    } satisfies Record<keyof ExperienceFields, string>,
  },

  learning: {
    roleLabel: (word: string) => `${word.charAt(0).toUpperCase()}${word.slice(1)} roles`,
    roleRationale: (count: number, word: string) => `You passed on ${count} jobs with “${word}” in the title.`,
    companyLabel: (company: string) => `Jobs at ${company}`,
    companyRationale: (count: number, company: string) => `You passed on ${count} jobs at ${company} because of the company.`,
    workModeLabel: (modes: string[]) => `${modes.map((m) => `${m.charAt(0).toUpperCase()}${m.slice(1)}`).join(" or ")} only`,
    workModeRationale: (count: number, modes: string[]) =>
      `You passed on ${count} ${joinAnd(modes)} jobs because of the work setup.`,
  },

  matching: {
    mustHaveConflict: (label: string) => `This job conflicts with your must-have: ${label}.`,
    dislikeConflict: (label: string) => `This looks like the kind of role you want to avoid: ${label}.`,
    outsidePath: "This role is outside the roles you're targeting, and you asked to skip adjacent roles.",
    notBuilding: "This role doesn't build on your proven experience closely enough.",
  },
};

export type Strings = typeof en;
