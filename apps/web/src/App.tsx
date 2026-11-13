import { useEffect, useRef, useState } from "react";
import type { Conversation, TurnInput } from "../../server/src/shared/types.ts";
import { request } from "./api.ts";
import { ReplyCard } from "./components/ReplyCard.tsx";
import { Inspector } from "./components/Inspector.tsx";

// Each is a case in scripts/curation-cases.json, so it is known to answer well.
const prompts: [string, string][] = [
  ["↗ Build an analysis", "How much power will the EU get from wind in 2050?"],
  [
    "◎ Studies for you",
    "I work on industry policy at the German economics ministry. Which studies matter to me?",
  ],
  ["⌘ Find your way", "Where can I find the model catalogue?"],
  ["◇ Understand a concept", "What is a baseline scenario?"],
];
/** What a reply is, in a word, for its tag. */
const kinds: Record<string, string> = {
  ask: "Question",
  review: "Query",
  result: "Data",
  studies: "Studies",
  answer: "Answer",
  insight: "Chart summary",
  navigation: "Page",
  help: "Help",
  error: "Problem",
};
type Status = { classifier: string; provider?: string; model?: string | null };

/** Chat workspace with saved conversations, constrained actions and a per-reply inspector. */
export function App() {
  const [conversations, setConversations] = useState<{ id: string; title: string }[]>([]);
  const [chat, setChat] = useState<Conversation>();
  const [status, setStatus] = useState<Status>({ classifier: "loading" });
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string>();
  const [inspect, setInspect] = useState(() => window.innerWidth >= 1150);
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
  return (
    <div className={`app ${inspect ? "inspecting" : ""}`}>
      <nav className="sidebar" aria-label="Conversations">
        <a className="brand" href="https://iamparis.eu" target="_blank" rel="noreferrer">
          <span className="brand-mark">i</span>
          <span>
            IAM<span className="accent">PARIS</span>
            <small>DATA ASSISTANT</small>
          </span>
        </a>
        <button
          className="new-chat"
          disabled={busy}
          onClick={() => {
            setChat(undefined);
            setSelected(undefined);
            setError("");
          }}
        >
          ＋ New conversation
        </button>
        <div className="section-label">CONVERSATIONS</div>
        <div className="conversation-list">
          {conversations.map((c) => (
            <button
              className={c.id === chat?.id ? "active" : ""}
              disabled={busy}
              key={c.id}
              onClick={() => open(c.id)}
            >
              ◌ <span>{c.title}</span>
            </button>
          ))}
          {!conversations.length && <p className="muted">Your conversations will appear here.</p>}
        </div>
        <div className="services">
          <div className="section-label">CONNECTED SOURCES</div>
          <p>
            <i /> IAMPARIS results <small>Live API</small>
          </p>
          <p>
            <i /> Curated knowledge <small>Local</small>
          </p>
          <p>
            <i /> Study catalogue <small>Snapshot</small>
          </p>
          <p title={status.provider ? `Provider: ${status.provider}` : undefined}>
            <i className={classifierReady ? "" : "manual"} /> Classifier{" "}
            <small>
              {status.classifier === "loading"
                ? "Checking"
                : classifierReady
                  ? (status.model ?? "Ready")
                  : status.classifier === "manual"
                    ? "Off"
                    : "Unavailable"}
            </small>
          </p>
        </div>
        <div className="sidebar-foot">
          Powered by constrained decisions
          <br />
          <span>No generated answers</span>
        </div>
      </nav>
      <main>
        <header>
          <button
            className="mobile-new"
            aria-label="New conversation"
            disabled={busy}
            onClick={() => {
              setChat(undefined);
              setSelected(undefined);
              setError("");
            }}
          >
            ＋
          </button>
          <div>
            <strong>{chat?.title ?? "IAMPARIS assistant"}</strong>
            <small>Studies, data, pages and concepts from IAMPARIS</small>
          </div>
          <button aria-pressed={inspect} onClick={() => setInspect((v) => !v)}>
            ◧ Inspector
          </button>
        </header>
        {!classifierReady && status.classifier !== "loading" && (
          <div className="banner">
            {status.classifier === "manual"
              ? "The classifier is switched off."
              : `The classifier${status.model ? ` (${status.model})` : ""} is not reachable.`}{" "}
            Exact wording, curated phrases and guided choices still work; free phrasing may need a
            clarifying question.
          </div>
        )}
        <section className="thread" aria-label="Chat messages">
          <div className="thread-inner">
            {!chat?.messages.length && (
              <div className="welcome">
                <div className="welcome-symbol">✳</div>
                <span className="eyebrow">YOUR GUIDE TO IAMPARIS</span>
                <h1>
                  From a question
                  <br />
                  to the right analysis.
                </h1>
                <p>
                  Tell me who you are and I will pick the studies that matter to you. Or ask for
                  data, a page, or a concept.
                </p>
                <div className="starter-grid">
                  {prompts.map(([label, p]) => (
                    <button disabled={busy} key={p} onClick={() => send({ text: p })}>
                      <span>{label}</span>
                      <p>{p}</p>
                      <b>→</b>
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
                    <span className="avatar">✳</span>
                    <strong>IAMPARIS</strong>
                    <span className="tag">
                      {kinds[message.reply?.kind ?? ""] ?? message.reply?.kind}
                    </span>
                    <button
                      onClick={() => {
                        setSelected(message.id);
                        setInspect(true);
                      }}
                    >
                      {message.reply?.trace.length ?? 0} decisions · Inspect ↗
                    </button>
                  </div>
                  {message.reply && (
                    <ReplyCard
                      reply={message.reply}
                      active={
                        !busy &&
                        message.id === last?.id &&
                        message.reply.token === chat.pending?.token
                      }
                      send={send}
                    />
                  )}
                </article>
              ),
            )}
            {busy && (
              <div role="status" className="loading">
                Checking available choices<span>…</span>
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
              aria-label="Message IAMPARIS"
              placeholder="What would you like to explore?"
              value={text}
              maxLength={4000}
              rows={2}
              disabled={busy}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (text.trim()) void send({ text });
                }
              }}
            />
            <button className="send" aria-label="Send message" disabled={busy || !text.trim()}>
              ↑
            </button>
          </form>
          <div className="composer-note">
            <span>Answers from curated content. Selections checked against published data.</span>
            <span>Enter to send</span>
          </div>
        </footer>
      </main>
      {inspect && <Inspector message={inspected} input={inspectedInput} />}
    </div>
  );
}
