import { useEffect, useRef, useState } from "react";
import type { Conversation, TurnInput } from "../../server/src/shared/types.ts";
import { request } from "./api.ts";
import { ReplyCard } from "./components/ReplyCard.tsx";
import { Inspector } from "./components/Inspector.tsx";
import { Icon } from "./components/Icon.tsx";
import type { IconName } from "./icons.ts";

// Each is a case in scripts/curation-cases.json, so it is known to answer well.
const prompts: [IconName, string, string][] = [
  ["chart", "Build an analysis", "How much power will the EU get from wind in 2050?"],
  [
    "book",
    "Studies for you",
    "I work on industry policy at the German economics ministry. Which studies matter to me?",
  ],
  ["compass", "Find your way", "Where can I find the model catalogue?"],
  ["toolbox", "Find a tool", "Is there a tool to explore countries' NDCs?"],
  ["lightbulb", "Understand a concept", "What is a baseline scenario?"],
];
/** What a reply is, in a word, for its tag. */
const kinds: Record<string, string> = {
  ask: "Question",
  review: "Query",
  result: "Data",
  studies: "Studies",
  apps: "Tools",
  answer: "Answer",
  insight: "Chart summary",
  navigation: "Page",
  help: "Help",
  error: "Problem",
};
type Status = { classifier: string; provider?: string; model?: string | null };
type Theme = "dark" | "light";

/** Same storage key as the IAMPARIS site, read before first paint by index.html. */
function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset.theme === "light" ? "light" : "dark",
  );
  return [
    theme,
    () => {
      const next = theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem("theme", next);
      } catch {
        // Storage blocked: the choice lasts until reload.
      }
      setTheme(next);
    },
  ];
}

/** Chat workspace with saved conversations, constrained actions and a per-reply explanation. */
export function App() {
  const [conversations, setConversations] = useState<{ id: string; title: string }[]>([]);
  const [chat, setChat] = useState<Conversation>();
  const [status, setStatus] = useState<Status>({ classifier: "loading" });
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string>();
  const [inspect, setInspect] = useState(() => window.innerWidth >= 1150);
  const [theme, toggleTheme] = useTheme();
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    Promise.all([
      request<{ id: string; title: string }[]>("/conversations"),
      request<Status>("/status"),
    ])
      .then(([list, s]) => {
        setConversations(list);
        setStatus(s);
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat?.messages.length, busy]);
  function reset() {
    setChat(undefined);
    setSelected(undefined);
    setError("");
  }
  async function open(id: string) {
    setBusy(true);
    setError("");
    try {
      setChat(await request<Conversation>(`/conversations/${id}`));
      setSelected(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function send(input: TurnInput) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const current = chat ?? (await request<Conversation>("/conversations", {}));
      setChat(current);
      const updated = await request<Conversation>(`/conversations/${current.id}/turn`, input);
      setChat(updated);
      setSelected(updated.messages.at(-1)?.id);
      setText("");
      setConversations(await request("/conversations"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const last = chat?.messages.findLast((m) => m.role === "assistant");
  const inspected = chat?.messages.find((m) => m.id === selected) ?? last;
  // The user message a reply answers sits right before it.
  const inspectedInput = inspected && chat?.messages[chat.messages.indexOf(inspected) - 1]?.text;
  const classifierReady = ["configured", "ready"].includes(status.classifier);
  const classifierLabel =
    status.classifier === "loading"
      ? "Checking"
      : classifierReady
        ? (status.model ?? "Ready")
        : status.classifier === "manual"
          ? "Off"
          : "Unavailable";
  return (
    <div className={`app ${inspect ? "inspecting" : ""}`}>
      <nav className="sidebar" aria-label="Conversations">
        <a className="brand" href="https://iamparis.eu" target="_blank" rel="noreferrer">
          <img src={`/brand/iam-paris-${theme}.svg`} alt="IAM PARIS" width={1040} height={480} />
          <span>Data assistant</span>
        </a>
        <button className="new-chat" disabled={busy} onClick={reset}>
          <Icon name="plus" /> New conversation
        </button>
        <div className="section-label">Conversations</div>
        <div className="conversation-list">
          {conversations.map((c) => (
            <button
              className={c.id === chat?.id ? "active" : ""}
              disabled={busy}
              key={c.id}
              onClick={() => open(c.id)}
              title={c.title}
            >
              <Icon name="message" />
              <span>{c.title}</span>
            </button>
          ))}
          {!conversations.length && (
            <p className="sidebar-empty">Your conversations will appear here.</p>
          )}
        </div>
        <div className="sidebar-foot">
          <div className="sources">
            <span>
              <i /> Live results, studies, tools and curated knowledge
            </span>
            <span title={status.provider ? `Provider: ${status.provider}` : undefined}>
              <i className={classifierReady ? "" : "warn"} /> Classifier: {classifierLabel}
            </span>
          </div>
          <button
            className="icon-button"
            onClick={toggleTheme}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} />
          </button>
        </div>
      </nav>
      <main>
        <header>
          <button
            className="icon-button mobile-new"
            aria-label="New conversation"
            disabled={busy}
            onClick={reset}
          >
            <Icon name="plus" />
          </button>
          <div className="header-title">
            <strong>{chat?.title ?? "Ask IAM PARIS"}</strong>
            <small>Studies, data, pages and concepts from IAM PARIS</small>
          </div>
          <button
            className={`toggle ${inspect ? "on" : ""}`}
            aria-pressed={inspect}
            aria-label="Behind the answer"
            onClick={() => setInspect((v) => !v)}
          >
            <Icon name="panel" /> <span>Behind the answer</span>
          </button>
        </header>
        {!classifierReady && status.classifier !== "loading" && (
          <div className="banner">
            <Icon name="alert" />
            <span>
              {status.classifier === "manual"
                ? "The classifier is switched off."
                : `The classifier${status.model ? ` (${status.model})` : ""} is not reachable.`}{" "}
              Exact wording, curated phrases and guided choices still work; free phrasing may need a
              clarifying question.
            </span>
          </div>
        )}
        <section className="thread" aria-label="Chat messages">
          <div className="thread-inner">
            {!chat?.messages.length && (
              <div className="welcome">
                <span className="eyebrow">Your guide to IAM PARIS</span>
                <h1>From a question to the right analysis</h1>
                <p>
                  Tell me who you are and I will pick the studies that matter to you. Or ask for
                  data, a page, a tool, or a concept.
                </p>
                <div className="starter-grid">
                  {prompts.map(([icon, label, p]) => (
                    <button disabled={busy} key={p} onClick={() => send({ text: p })}>
                      <span className="starter-icon">
                        <Icon name={icon} />
                      </span>
                      <span className="starter-text">
                        <strong>{label}</strong>
                        <span>{p}</span>
                      </span>
                      <Icon name="arrowRight" className="starter-arrow" />
                    </button>
                  ))}
                </div>
              </div>
            )}
            {chat?.messages.map((message) =>
              message.role === "user" ? (
                <div className="user-message" key={message.id}>
                  {message.text}
                </div>
              ) : (
                <article
                  className={`assistant-message ${message.id === (selected ?? last?.id) ? "selected" : ""}`}
                  key={message.id}
                >
                  <div className="message-meta">
                    <img className="avatar" src="/brand/iam-paris-icon-32.png" alt="" />
                    <strong>IAM PARIS</strong>
                    <span className="tag">
                      {kinds[message.reply?.kind ?? ""] ?? message.reply?.kind}
                    </span>
                    <button
                      className="why"
                      onClick={() => {
                        setSelected(message.id);
                        setInspect(true);
                      }}
                    >
                      Why this answer?
                    </button>
                  </div>
                  {message.reply && (
                    <div className="message-body">
                      <ReplyCard
                        reply={message.reply}
                        active={
                          !busy &&
                          message.id === last?.id &&
                          message.reply.token === chat.pending?.token
                        }
                        send={send}
                      />
                    </div>
                  )}
                </article>
              ),
            )}
            {busy && (
              <div role="status" className="loading">
                <span className="dot" />
                <span className="dot" />
                <span className="dot" />
                Checking available choices
              </div>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div ref={bottom} />
          </div>
        </section>
        <footer>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) void send({ text });
            }}
          >
            <textarea
              aria-label="Message IAM PARIS"
              placeholder="Ask a question…"
              value={text}
              maxLength={4000}
              rows={2}
              disabled={busy}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (text.trim()) void send({ text });
                }
              }}
            />
            <div className="composer-row">
              <span>Answers come from curated content and live data, never generated text.</span>
              <button className="send" aria-label="Send message" disabled={busy || !text.trim()}>
                <Icon name="arrowUp" />
              </button>
            </div>
          </form>
        </footer>
      </main>
      {inspect && (
        <Inspector message={inspected} input={inspectedInput} onClose={() => setInspect(false)} />
      )}
    </div>
  );
}
