import { useState } from "react";
import type { Decision, Message, Outcome } from "../../../server/src/shared/types.ts";

type Group = "classifier" | "wording" | "rule" | "user";
const groupOf = (d: Decision): Group =>
  d.source === "user"
    ? "user"
    : d.source === "match"
      ? "wording"
      : d.source === "policy"
        ? "rule"
        : "classifier";
/** Who decided, named by role rather than by provider; the model is shown in the step's details. */
const groupLabels: Record<Group, string> = {
  classifier: "Classifier",
  wording: "Wording",
  rule: "Rule",
  user: "User",
};
const outcomeLabels: Record<Outcome, string> = {
  accepted: "Used",
  overruled: "Overruled",
  unsure: "Unsure",
  none: "Not mentioned",
  error: "Failed",
};
/** Replies stored before outcomes were recorded: read one off the choice and error. */
const outcomeOf = (d: Decision): Outcome =>
  d.outcome ?? (d.error ? "error" : d.choice ? "accepted" : "unsure");
const isIssue = (d: Decision) => ["overruled", "unsure", "error"].includes(outcomeOf(d));
const percent = (p?: number) => (p === undefined ? "—" : `${Math.round(p * 100)}%`);
const title = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const dimensionNames: Record<string, string> = {
  workspace_code: "study",
  modelName: "model",
  tag: "topic",
};

/** One decision: what was decided, by whom, how it ended and why; details on demand. */
function Step({ decision, index }: { decision: Decision; index: number }) {
  const outcome = outcomeOf(decision);
  const group = groupOf(decision);
  const [open, setOpen] = useState(isIssue(decision));
  const [all, setAll] = useState(false);
  const chosen = decision.options.find((o) => o.id === decision.choice);
  const scored = Object.keys(decision.probabilities).length > 0;
  const options = [...decision.options].sort(
    (a, b) => (decision.probabilities[b.id] ?? 0) - (decision.probabilities[a.id] ?? 0),
  );
  const gate = decision.thresholds?.confidence;
  // A rule states what it did in its question; a choice is headed by the value picked.
  const picked = decision.choice ? `→ ${chosen?.label ?? decision.choice}` : undefined;
  const headline =
    group === "rule"
      ? decision.question
      : (picked ?? (outcome === "none" ? "Nothing named" : "No clear choice"));
  return (
    <li className={`step ${group} ${outcome}`}>
      <button className="step-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="step-index">{index + 1}</span>
        <span className="step-main">
          <span className="step-subject">
            {title(decision.subject ?? "decision")}
            <em>{groupLabels[group]}</em>
          </span>
          <span className={`step-value ${outcome === "overruled" ? "struck" : ""}`}>
            {headline}
          </span>
          {group === "rule" && picked && <span className="step-value">{picked}</span>}
        </span>
        <span className="step-side">
          <span className={`outcome ${outcome}`}>{outcomeLabels[outcome]}</span>
          {decision.ms > 0 && <small>{decision.ms} ms</small>}
        </span>
      </button>
      {(decision.reason || decision.error) && (
        <p className="step-reason">{decision.error ?? decision.reason}</p>
      )}
      {open && group !== "rule" && (
        <div className="step-detail">
          <dl>
            <dt>Question</dt>
            <dd>{decision.question}</dd>
            {decision.state && (
              <>
                <dt>Judged text</dt>
                <dd className="quoted">{decision.state}</dd>
              </>
            )}
          </dl>
          {decision.options.length > 0 && (
            <div className="bars">
              {(all ? options : options.slice(0, 6)).map((option) => (
                <div
                  className={`bar ${option.id === decision.choice ? "chosen" : ""}`}
                  key={option.id}
                  title={option.detail}
                >
                  <div>
                    <span>{option.label}</span>
                    <small>{scored ? percent(decision.probabilities[option.id]) : ""}</small>
                  </div>
                  {scored && (
                    <div className="track">
                      <i style={{ width: percent(decision.probabilities[option.id] ?? 0) }} />
                      {gate !== undefined && <b style={{ left: percent(gate) }} />}
                    </div>
                  )}
                </div>
              ))}
              {scored && decision.noneProbability !== undefined && (
                <div className="bar none">
                  <div>
                    <span>None of these / not mentioned</span>
                    <small>{percent(decision.noneProbability)}</small>
                  </div>
                  <div className="track">
                    <i style={{ width: percent(decision.noneProbability) }} />
                    {gate !== undefined && <b style={{ left: percent(gate) }} />}
                  </div>
                </div>
              )}
              {options.length > 6 && (
                <button className="text-button" onClick={() => setAll((v) => !v)}>
                  {all ? "Show fewer" : `Show all ${options.length} options`}
                </button>
              )}
            </div>
          )}
          {group === "classifier" && (
            <p className="step-meta">
              {[
                decision.model,
                decision.thresholds &&
                  `accepts ≥ ${percent(decision.thresholds.confidence)} with a ${Math.round(decision.thresholds.margin * 100)}-point lead`,
                decision.offered !== undefined &&
                  decision.offered > decision.options.length &&
                  `${decision.options.length} of ${decision.offered} options ranked closest were asked`,
                decision.tokens && `${decision.tokens.input} + ${decision.tokens.output} tokens`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

/** The state a turn left behind: what the next message will be read against. */
function State({ message }: { message: Message }) {
  const state = message.reply?.state;
  if (!state) return null;
  const { draft, brief, pending } = state;
  const rows: [string, string][] = [];
  if (pending)
    rows.push([
      "Waiting for",
      pending.kind === "review" || (pending.kind === "studies" && !pending.facet)
        ? "a change, or a new request"
        : `the user's ${dimensionNames[pending.facet ?? pending.dimension ?? ""] ?? pending.facet ?? pending.dimension ?? pending.kind}`,
    ]);
  else rows.push(["Waiting for", "a new request"]);
  if (brief) {
    for (const [key, values] of Object.entries(brief.selection))
      if (values?.length)
        rows.push([
          title(dimensionNames[key] ?? key),
          `${values.join(", ")}${brief.evidence[key as keyof typeof brief.evidence] ? `  (${brief.evidence[key as keyof typeof brief.evidence]})` : ""}`,
        ]);
    if (brief.settled.length)
      rows.push(["Not asked again", brief.settled.map((k) => dimensionNames[k] ?? k).join(", ")]);
  }
  if (draft) {
    for (const [key, values] of Object.entries(draft.filters))
      if (values?.length)
        rows.push([
          title(dimensionNames[key] ?? key),
          `${values.length > 4 ? `${values.slice(0, 4).join(", ")} +${values.length - 4}` : values.join(", ")}${draft.assumed?.includes(key as never) ? "  (assumed)" : ""}`,
        ]);
    rows.push(["Years", draft.years.length ? draft.years.join(", ") : "all published"]);
  }
  return (
    <section className="inspector-section">
      <h4>State after this turn</h4>
      <dl className="state">
        {rows.map(([key, value], i) => (
          <div key={i}>
            <dt>{key}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

const filters: { id: "all" | Group | "issues"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "classifier", label: "Classifier" },
  { id: "wording", label: "Wording" },
  { id: "rule", label: "Rules" },
  { id: "issues", label: "Issues" },
];

/**
 * How one reply came about: every decision in order (classifier, wording match, rule in code or
 * the user's click), what each was asked, how it ended and why, and the state the turn left.
 */
export function Inspector({ message, input }: { message?: Message; input?: string }) {
  const [filter, setFilter] = useState<(typeof filters)[number]["id"]>("all");
  const [copied, setCopied] = useState(false);
  const trace = message?.reply?.trace ?? [];
  const count = (id: (typeof filters)[number]["id"]) =>
    id === "all"
      ? trace.length
      : id === "issues"
        ? trace.filter(isIssue).length
        : trace.filter((d) => groupOf(d) === id).length;
  const shown = trace
    .map((decision, index) => ({ decision, index }))
    .filter(({ decision }) =>
      filter === "all"
        ? true
        : filter === "issues"
          ? isIssue(decision)
          : groupOf(decision) === filter,
    );
  const model = trace.find((d) => groupOf(d) === "classifier")?.model;
  return (
    <aside className="inspector" aria-label="Decision inspector">
      <div className="pane-title">
        <span>Decision inspector</span>
        {message?.reply && (
          <button
            className="text-button"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(JSON.stringify({ input, ...message.reply }, null, 2))
                .then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
            }}
          >
            {copied ? "Copied" : "Copy JSON"}
          </button>
        )}
      </div>
      {!message?.reply ? (
        <div className="inspector-empty">
          ◇<p>Nothing to inspect yet.</p>
          <small>Send a message, then select a reply to see how it was decided.</small>
        </div>
      ) : (
        <>
          <section className="inspector-section summary">
            {input && <p className="quoted">{input}</p>}
            <div className="summary-line">
              <span className="tag">{message.reply.kind}</span>
              {message.reply.ms !== undefined && <span>{message.reply.ms} ms</span>}
              <span>
                {count("classifier")} classifier · {count("wording")} wording · {count("rule")} rule
                {count("rule") === 1 ? "" : "s"}
                {count("user") ? ` · ${count("user")} click` : ""}
              </span>
            </div>
            {model && <small className="muted">Classifier model: {model}</small>}
          </section>
          <section className="inspector-section">
            <h4>Decisions</h4>
            {trace.length > 0 && (
              <div className="filter-row" role="tablist">
                {filters
                  .filter((f) => f.id === "all" || count(f.id) > 0)
                  .map((f) => (
                    <button
                      key={f.id}
                      role="tab"
                      aria-selected={filter === f.id}
                      className={filter === f.id ? "on" : ""}
                      onClick={() => setFilter(f.id)}
                    >
                      {f.label} <small>{count(f.id)}</small>
                    </button>
                  ))}
              </div>
            )}
            {trace.length === 0 && (
              <p className="muted">
                No decision was needed: the reply follows directly from the conversation state.
              </p>
            )}
            <ol className="steps">
              {shown.map(({ decision, index }) => (
                <Step key={`${message.id}-${index}`} decision={decision} index={index} />
              ))}
            </ol>
          </section>
          <State message={message} />
        </>
      )}
    </aside>
  );
}
