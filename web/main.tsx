import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { ConversationLanguage } from "../src/domain/enums.js";
import {
  INIT_DATA_HEADER,
  type ExploreAction,
  type ExploreData,
  type ExploreDetails,
  type ExploreItem,
  type ExploreTab,
  type HoldReason,
} from "../src/miniapp/types.js";
import { textDirection } from "./bidi.js";
import { WEB_STRINGS, type WebStrings } from "./strings.js";

interface TelegramWebApp {
  initData: string;
  initDataUnsafe: { user?: { language_code?: string } };
  ready(): void;
  expand(): void;
  openLink(url: string): void;
  HapticFeedback?: { notificationOccurred(type: "success" | "error"): void };
}

const telegram = (window as unknown as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp;
const TABS: ExploreTab[] = ["matches", "close", "blocked", "waiting", "hidden"];
const PAGE = 40;
const reasonKey = (reason: HoldReason) => ("label" in reason ? `${reason.kind}:${reason.label}` : reason.kind);

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", [INIT_DATA_HEADER]: telegram?.initData ?? "", ...init.headers },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as T;
}

function App() {
  const guess: ConversationLanguage = telegram?.initDataUnsafe.user?.language_code === "he" ? "he" : "en";
  const [data, setData] = useState<ExploreData | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<ExploreTab>("matches");
  const [reason, setReason] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const language = data?.language ?? guess;
  const t = WEB_STRINGS[language];

  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = language === "he" ? "rtl" : "ltr";
  }, [language]);

  useEffect(() => {
    telegram?.ready();
    telegram?.expand();
    if (!telegram?.initData) return;
    api<ExploreData>("/api/app").then(setData, () => setFailed(true));
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(timer);
  }, [toast]);

  const counts = useMemo(() => {
    const byTab = Object.fromEntries(TABS.map((key) => [key, 0])) as Record<ExploreTab, number>;
    for (const item of data?.items ?? []) byTab[item.tab]++;
    return byTab;
  }, [data]);

  const inTab = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (data?.items ?? []).filter(
      (item) =>
        item.tab === tab &&
        words.every((word) => `${item.title} ${item.company ?? ""} ${item.location ?? ""}`.toLowerCase().includes(word)),
    );
  }, [data, tab, query]);

  const reasons = useMemo(() => {
    const groups = new Map<string, { reason: HoldReason; count: number }>();
    for (const item of inTab) {
      for (const r of item.reasons) {
        const group = groups.get(reasonKey(r)) ?? { reason: r, count: 0 };
        group.count++;
        groups.set(reasonKey(r), group);
      }
    }
    return [...groups.entries()].sort((a, b) => b[1].count - a[1].count);
  }, [inTab]);

  const visible = reason ? inTab.filter((item) => item.reasons.some((r) => reasonKey(r) === reason)) : inTab;

  const choose = (next: ExploreTab) => {
    setTab(next);
    setReason(null);
    setLimit(PAGE);
    setOpen(null);
  };

  const act = async (item: ExploreItem, action: ExploreAction) => {
    const before = data;
    const update = (patch: Partial<ExploreItem>) =>
      setData((current) =>
        current ? { ...current, items: current.items.map((i) => (i.matchId === item.matchId ? { ...i, ...patch } : i)) } : current,
      );
    if (action === "interested") update({ feedback: "interested", tab: "matches" });
    if (action === "not_interested") update({ feedback: "not_interested", tab: "hidden" });
    if (action === "applied") update({ applied: true });
    try {
      await api("/api/app", { method: "POST", body: JSON.stringify({ matchId: item.matchId, action }) });
      telegram?.HapticFeedback?.notificationOccurred("success");
      setToast(
        action === "applied" ? t.appliedSaved : action === "not_interested" ? t.hidden : item.tab === "matches" ? t.saved : t.movedToMatches,
      );
      if (action !== "applied") setOpen(null);
    } catch {
      setData(before);
      telegram?.HapticFeedback?.notificationOccurred("error");
      setToast(t.actionFailed);
    }
  };

  if (!telegram?.initData) return <p class="state">{t.outsideTelegram}</p>;
  if (failed) return <p class="state">{t.failed}</p>;
  if (!data) return <p class="state">{t.loading}</p>;

  return (
    <main>
      <header>
        <h1>{t.title}</h1>
        <input type="search" dir="auto" placeholder={t.search} value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
        <nav class="chips">
          {TABS.filter((key) => key === "matches" || counts[key] > 0).map((key) => (
            <button class={key === tab ? "chip active" : "chip"} onClick={() => choose(key)}>
              <bdi>{t.tabs[key]}</bdi>
              <span class="count">{counts[key]}</span>
            </button>
          ))}
        </nav>
      </header>

      <p class="hint">{t.tabHints[tab]}</p>

      {reasons.length > 1 && (
        <nav class="chips reasons">
          <button class={reason === null ? "chip small active" : "chip small"} onClick={() => setReason(null)}>
            <bdi>{t.allReasons}</bdi>
            <span class="count">{inTab.length}</span>
          </button>
          {reasons.map(([key, group]) => (
            <button class={key === reason ? "chip small active" : "chip small"} onClick={() => (setReason(key), setLimit(PAGE))}>
              <bdi>{t.reason(group.reason)}</bdi>
              <span class="count">{group.count}</span>
            </button>
          ))}
        </nav>
      )}

      {visible.length === 0 && <p class="state">{t.empty}</p>}
      <ul class="cards">
        {visible.slice(0, limit).map((item) => (
          <JobCard
            key={item.matchId}
            item={item}
            t={t}
            language={language}
            open={open === item.matchId}
            onToggle={() => setOpen(open === item.matchId ? null : item.matchId)}
            onAct={(action) => act(item, action)}
          />
        ))}
      </ul>
      {visible.length > limit && (
        <button class="more" onClick={() => setLimit(limit + PAGE)}>
          {t.showMore(Math.min(PAGE, visible.length - limit))}
        </button>
      )}
      {toast && <div class="toast">{toast}</div>}
    </main>
  );
}

const detailsCache = new Map<string, Promise<ExploreDetails>>();

function JobCard(props: {
  item: ExploreItem;
  t: WebStrings;
  language: ConversationLanguage;
  open: boolean;
  onToggle: () => void;
  onAct: (action: ExploreAction) => void;
}) {
  const { item, t, open } = props;
  const [details, setDetails] = useState<ExploreDetails | null>(null);
  const [fullText, setFullText] = useState(false);

  useEffect(() => {
    if (!open || details) return;
    let request = detailsCache.get(item.matchId);
    if (!request) {
      request = api<ExploreDetails>(`/api/app?match=${item.matchId}`);
      detailsCache.set(item.matchId, request);
    }
    request.then(setDetails, () => detailsCache.delete(item.matchId));
  }, [open, item.matchId, details]);

  return (
    <li class={open ? "card open" : "card"}>
      <button class="card-head" onClick={props.onToggle}>
        <span class="job-title page-aligned" dir={textDirection(item.title)}>
          {item.title}
        </span>
        {(item.company || item.location) && (
          <span class="place page-aligned">
            {[item.company, item.location]
              .filter((part): part is string => Boolean(part))
              .map((part, i) => (
                <span class="place-part" key={i}>
                  {i > 0 && "· "}
                  <bdi>{part}</bdi>
                </span>
              ))}
          </span>
        )}
        <span class="badges">
          {item.recommendation && item.tab === "matches" && (
            <span class={`badge ${item.recommendation}`}>{t.recommendation[item.recommendation]}</span>
          )}
          {item.reasons.map((reason) => (
            <bdi class="badge reason">{t.reason(reason)}</bdi>
          ))}
          {item.applied && <span class="badge applied">{t.appliedDone}</span>}
          <span class="meta">
            <bdi>{item.sourceName}</bdi> · {ago(item.foundAt, props.language)}
          </span>
        </span>
        {item.explanation && <span class={open ? "explanation" : "explanation clamp"} dir={textDirection(item.explanation)}>{item.explanation}</span>}
      </button>

      {open && (
        <div class="card-body">
          {!details && <p class="hint">{t.loadingDetails}</p>}
          {details && details.fitEvidence.length > 0 && <Section title={t.why} lines={details.fitEvidence} />}
          {details && details.gaps.length > 0 && <Section title={t.gaps} lines={details.gaps} />}
          {details && (
            <section>
              <h3>{t.description}</h3>
              <p class={fullText ? "description" : "description clamp-long"} dir={textDirection(details.description)}>{details.description}</p>
              {!fullText && details.description.length > 400 && (
                <button class="link" onClick={() => setFullText(true)}>
                  {t.readMore}
                </button>
              )}
            </section>
          )}
          <div class="actions">
            {details && (
              <button class="primary" onClick={() => (telegram ? telegram.openLink(details.url) : window.open(details.url, "_blank"))}>
                {t.openPosting}
              </button>
            )}
            {item.feedback !== "interested" && (
              <button onClick={() => props.onAct("interested")}>{item.tab === "matches" ? t.interested : t.showAnyway}</button>
            )}
            {item.tab !== "hidden" && <button onClick={() => props.onAct("not_interested")}>{t.notInterested}</button>}
            {!item.applied && <button onClick={() => props.onAct("applied")}>{t.applied}</button>}
          </div>
        </div>
      )}
    </li>
  );
}

function Section(props: { title: string; lines: string[] }) {
  return (
    <section>
      <h3>{props.title}</h3>
      <ul class="bullets">
        {props.lines.map((line) => (
          <li dir={textDirection(line)}>{line}</li>
        ))}
      </ul>
    </section>
  );
}

function ago(iso: string, language: ConversationLanguage): string {
  const days = Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
  return new Intl.RelativeTimeFormat(language, { numeric: "auto" }).format(days, "day");
}

render(<App />, document.getElementById("root")!);
