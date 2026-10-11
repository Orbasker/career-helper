import type { ConversationLanguage, MatchRecommendation } from "../src/domain/enums.js";
import type { ExploreTab, HoldReason } from "../src/miniapp/types.js";

export interface WebStrings {
  title: string;
  search: string;
  tabs: Record<ExploreTab, string>;
  tabHints: Record<ExploreTab, string>;
  allReasons: string;
  reason: (reason: HoldReason) => string;
  recommendation: Record<MatchRecommendation, string>;
  showMore: (n: number) => string;
  empty: string;
  loading: string;
  loadingDetails: string;
  failed: string;
  outsideTelegram: string;
  openPosting: string;
  interested: string;
  showAnyway: string;
  notInterested: string;
  applied: string;
  appliedDone: string;
  why: string;
  gaps: string;
  description: string;
  readMore: string;
  saved: string;
  movedToMatches: string;
  hidden: string;
  appliedSaved: string;
  actionFailed: string;
}

const en: WebStrings = {
  title: "Your jobs",
  search: "Search title, company or city",
  tabs: { matches: "Matches", close: "Close calls", blocked: "Blocked by my rules", waiting: "Still checking", hidden: "Not for me" },
  tabHints: {
    matches: "Jobs I checked and think are worth your time.",
    close: "Jobs I looked at closely but held back. Tap one to see why, or bring it back.",
    blocked: "Jobs that break one of your must-haves. Closest to your profile first.",
    waiting: "Jobs I haven't fully checked yet. The best ones arrive in your daily digest.",
    hidden: "Jobs you said aren't for you.",
  },
  allReasons: "All",
  reason: (reason) => {
    switch (reason.kind) {
      case "must_have":
        return `⛔ ${reason.label}`;
      case "dislike":
        return `🙅 ${reason.label}`;
      case "outside_path":
        return "🧭 Outside your path";
      case "not_a_fit":
        return "🤖 Not a strong fit";
      case "low_relevance":
        return "📉 Looks unrelated";
    }
  },
  recommendation: { strong_fit: "Strong fit", good_fit: "Good fit", stretch: "Stretch", not_recommended: "Not recommended" },
  showMore: (n) => `Show ${n} more`,
  empty: "Nothing here.",
  loading: "Loading your jobs…",
  loadingDetails: "Loading details…",
  failed: "I couldn't load your jobs. Pull down to try again.",
  outsideTelegram: "Open this page from the bot in Telegram.",
  openPosting: "🔗 Open posting",
  interested: "👍 Interested",
  showAnyway: "👍 Add to my matches",
  notInterested: "👎 Not for me",
  applied: "✅ I applied",
  appliedDone: "✅ Applied",
  why: "Why it fits",
  gaps: "What's missing",
  description: "About the job",
  readMore: "Read more",
  saved: "Saved",
  movedToMatches: "Added to your matches",
  hidden: "Hidden",
  appliedSaved: "Marked as applied",
  actionFailed: "That didn't work. Try again.",
};

const he: WebStrings = {
  title: "המשרות שלך",
  search: "חיפוש לפי תפקיד, חברה או עיר",
  tabs: { matches: "התאמות", close: "כמעט התאמות", blocked: "נחסמו לפי הכללים שלי", waiting: "עדיין בבדיקה", hidden: "לא בשבילי" },
  tabHints: {
    matches: "משרות שבדקתי ושלדעתי שוות את הזמן שלך.",
    close: "משרות שבדקתי לעומק אבל עצרתי. אפשר ללחוץ כדי לראות למה, או להחזיר אותן.",
    blocked: "משרות שמתנגשות באחד מתנאי החובה שלך. הקרובות ביותר לפרופיל שלך קודם.",
    waiting: "משרות שעוד לא סיימתי לבדוק. הטובות יגיעו בסיכום היומי.",
    hidden: "משרות שסימנת שהן לא בשבילך.",
  },
  allReasons: "הכל",
  reason: (reason) => {
    switch (reason.kind) {
      case "must_have":
        return `⛔ ${reason.label}`;
      case "dislike":
        return `🙅 ${reason.label}`;
      case "outside_path":
        return "🧭 מחוץ למסלול שלך";
      case "not_a_fit":
        return "🤖 לא מספיק מתאימה";
      case "low_relevance":
        return "📉 נראית לא קשורה";
    }
  },
  recommendation: { strong_fit: "התאמה חזקה", good_fit: "התאמה טובה", stretch: "מאתגרת", not_recommended: "לא מומלצת" },
  showMore: (n) => `עוד ${n}`,
  empty: "אין כאן כלום.",
  loading: "טוען את המשרות שלך…",
  loadingDetails: "טוען פרטים…",
  failed: "לא הצלחתי לטעון את המשרות. נסו שוב.",
  outsideTelegram: "יש לפתוח את העמוד הזה מהבוט בטלגרם.",
  openPosting: "🔗 למודעה",
  interested: "👍 מעניין אותי",
  showAnyway: "👍 להוסיף להתאמות",
  notInterested: "👎 לא בשבילי",
  applied: "✅ הגשתי",
  appliedDone: "✅ הוגש",
  why: "למה זה מתאים",
  gaps: "מה חסר",
  description: "על המשרה",
  readMore: "להמשך קריאה",
  saved: "נשמר",
  movedToMatches: "נוסף להתאמות שלך",
  hidden: "הוסתר",
  appliedSaved: "סומן כהוגש",
  actionFailed: "זה לא הצליח. נסו שוב.",
};

export const WEB_STRINGS: Record<ConversationLanguage, WebStrings> = { en, he };
