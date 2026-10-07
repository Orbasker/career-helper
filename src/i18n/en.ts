import type {
  CareerFactKind,
  ConversationLanguage,
  MatchRecommendation,
  PreferenceKind,
  ProfileSourceKind,
  SeniorityLevel,
  WorkMode,
} from "../domain/enums.js";
import type { ExperienceFields, ProfileFields } from "../domain/profile.js";
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
    somethingElse: "✍️ Something else",
    yes: "✅ Yes",
    no: "✖️ No",
    approve: "✅ Approve",
    discard: "🗑 Discard",
    sendDocument: "📄 Send document",
    deleteConnections: "🗑 Delete my connections",
    analyze: "🔍 Analyze",
    showBoards: "🏢 Show boards",
    manageSites: "⭐ Manage my sites",
    addSite: "⭐ Add a site",
    confirmProfile: "✅ Confirm profile",
    apply: "✅ Apply",
    cancel: "✖️ Cancel",
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
    cvApproved: "Saved ✅ Here's your CV for this job as a Word document.",
    cvDocumentCaption: "Your tailored CV. Every line comes from your confirmed profile.",
    cvDocumentFailed: "Your CV is saved, but I couldn't create the document right now. Tap below to try again.",
    cvDiscarded: "Discarded. Tap <b>Tailor my CV</b> on the job to start over.",
    help: [
      "<b>What I can do</b>",
      "• /new — your latest matches",
      "• /profile — your career profile",
      "• Send an updated CV (PDF, DOCX or TXT) anytime — I'll show what it adds to your profile before saving anything.",
      "• /sources — where I search for jobs and what I found there",
      "• /sites — job sites I search for you (add one with /addsite example.co.il)",
      "• /connections — import your LinkedIn connections to see who you know at each company",
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

  documentLanguages: { en: "English", he: "Hebrew" } satisfies Record<ConversationLanguage, string>,

  documents: {
    languageButton: (language: string, detected: boolean) => `🌐 ${detected ? `It's ${language}` : language}`,
    languageMarked: (language: string) => `Marked as ${language} ✅`,
    saved: (source: string, fileName: string | null, language: string | null, version: number) =>
      `Saved ${source}${fileName ? ` (${fileName})` : ""}${language ? ` · ${language}` : ""}${
        version > 1 ? ` · version ${version}` : ""
      } ✅ Your earlier documents are kept too.`,
  },

  jobSources: {
    title: "<b>Where I search for jobs</b>",
    boardsHeading: "🏢 <b>Company job boards</b>",
    boards: (count: number, perSource: string, collected: string | null) =>
      `${plural(count, "official board", "official boards")} (${perSource}), checked every day. ${
        collected ? `Last collected ${collected}.` : "Not collected yet."
      }`,
    noBoards: "No company boards yet. Board links I find on the web are added here automatically.",
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

  provenance: {
    heading: "<b>Where I found it</b>",
    board: (source: string) => `🏢 Official company job board (${source})`,
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
