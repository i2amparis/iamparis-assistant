import { useState, type ReactNode } from "react";
import type { Decision, Message, Outcome } from "../../../server/src/shared/types.ts";
import { Icon } from "./Icon.tsx";

/** Replies stored before outcomes were recorded: read one off the choice and error. */
const outcomeOf = (d: Decision): Outcome =>
  d.outcome ?? (d.error ? "error" : d.choice ? "accepted" : "unsure");
const percent = (p?: number) => (p === undefined ? "—" : `${Math.round(p * 100)}%`);
const title = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const subjectOf = (d: Decision) => title(d.subject ?? "decision");
const dimensionNames: Record<string, string> = {
  workspace_code: "study",
  modelName: "model",
  tag: "topic",
};
/** "a, b and c" */
const list = (items: string[]) =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/** Who settled a value, in words a reader without the code understands. */
function sourceBadge(d: Decision): { label: string; tone: string; hint: string } {
  if (d.source === "user")
    return { label: "You chose", tone: "brand", hint: "Picked from the offered options." };
  if (d.source === "match")
    return {
      label: "Your words",
      tone: "success",
      hint: "Found word for word in the message, so the classifier was not asked.",
    };
  if (d.source === "policy")
    return { label: "Rule", tone: "neutral", hint: "A fixed rule in the assistant's code." };
  const p = d.choice ? d.probabilities[d.choice] : undefined;
  return {
    label: p === undefined ? "Classifier" : `Classifier · ${percent(p)}`,
    tone: "info",
    hint: `Picked from a fixed list by ${d.model ?? "the classifier"}; it never writes text.`,
  };
}

/** The question, the judged text and every option's score: the evidence behind one decision. */
function Evidence({ decision }: { decision: Decision }) {
  const [all, setAll] = useState(false);
  const scored = Object.keys(decision.probabilities).length > 0;
  const options = [...decision.options].sort(
    (a, b) => (decision.probabilities[b.id] ?? 0) - (decision.probabilities[a.id] ?? 0),
  );
  const gate = decision.thresholds?.confidence;
  const meta = [
    decision.model,
    decision.ms > 0 && `${decision.ms} ms`,
    decision.thresholds &&
      `needs ${percent(decision.thresholds.confidence)} and a ${Math.round(decision.thresholds.margin * 100)}-point lead`,
    decision.offered !== undefined &&
      decision.offered > decision.options.length &&
      `${decision.options.length} closest of ${decision.offered} options asked`,
    decision.tokens && `${decision.tokens.input} + ${decision.tokens.output} tokens`,
  ].filter(Boolean);
  return (
    <div className="evidence">
      <p className="evidence-question">{decision.question}</p>
      {decision.state && <p className="quoted">{decision.state}</p>}
      {scored && decision.options.length > 0 && (
        <div className="bars">
          {(all ? options : options.slice(0, 5)).map((option) => (
            <div
              className={`bar ${option.id === decision.choice ? "chosen" : ""}`}
              key={option.id}
              title={option.detail}
            >
              <div>
                <span>{option.label}</span>
                <small>{percent(decision.probabilities[option.id])}</small>
              </div>
              <div className="track">
                <i style={{ width: percent(decision.probabilities[option.id] ?? 0) }} />
                {gate !== undefined && <b style={{ left: percent(gate) }} />}
              </div>
            </div>
          ))}
          {decision.noneProbability !== undefined && (
            <div className="bar none">
              <div>
                <span>None of these</span>
                <small>{percent(decision.noneProbability)}</small>
              </div>
              <div className="track">
                <i style={{ width: percent(decision.noneProbability) }} />
                {gate !== undefined && <b style={{ left: percent(gate) }} />}
              </div>
            </div>
          )}
          {options.length > 5 && (
            <button className="text-button" onClick={() => setAll((v) => !v)}>
              {all ? "Show fewer" : `Show all ${options.length} options`}
            </button>
          )}
        </div>
      )}
      {meta.length > 0 && <p className="evidence-meta">{meta.join(" · ")}</p>}
    </div>
  );
}

/** One settled value: what it is about, what was picked, who picked it and why. */
function Fact({ decision, open: initial = false }: { decision: Decision; open?: boolean }) {
  const [open, setOpen] = useState(initial);
  const outcome = outcomeOf(decision);
  const badge = sourceBadge(decision);
  const chosen = decision.options.find((o) => o.id === decision.choice);
  const rule = decision.source === "policy";
  // A rule's question already says what it did ("Only one region has data here.").
  const value =
    chosen?.label ??
    decision.choice ??
    (outcome === "overruled"
      ? "Not used"
      : outcome === "unsure"
        ? "No clear winner"
        : rule
          ? (decision.reason ?? decision.question)
          : "—");
  const note = rule
    ? decision.choice
      ? [decision.question, decision.reason].filter(Boolean).join(" ")
      : decision.reason && decision.question
    : (decision.error ?? decision.reason);
  // A rule has nothing behind it but its own sentence.
  const expandable = !rule && (decision.options.length > 0 || Boolean(decision.state));
  return (
    <li className={`fact ${outcome}`}>
      <button
        className="fact-head"
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="fact-main">
          <span className="fact-subject">{subjectOf(decision)}</span>
          <span className={`fact-value ${outcome === "overruled" ? "struck" : ""}`}>{value}</span>
        </span>
        <span className={`badge ${badge.tone}`} title={badge.hint}>
          {badge.label}
        </span>
        {expandable && <Icon name="chevronDown" className={`chevron ${open ? "open" : ""}`} />}
      </button>
      {note && <p className="fact-note">{note}</p>}
      {open && expandable && <Evidence decision={decision} />}
    </li>
  );
}

/** What the next message will be read against, as label/value rows. */
function memoryRows(message: Message): [string, string][] {
  const state = message.reply?.state;
  if (!state) return [];
  const { draft, brief, finder, pending } = state;
  const rows: [string, string][] = [];
  rows.push([
    "Waiting for",
    !pending
      ? "a new request"
      : pending.kind === "review" ||
          pending.kind === "apps" ||
          (pending.kind === "studies" && !pending.facet)
        ? "a change, or a new request"
        : `your ${dimensionNames[pending.facet ?? pending.dimension ?? ""] ?? pending.facet ?? pending.dimension ?? pending.kind}`,
  ]);
  if (brief) {
    for (const [key, values] of Object.entries(brief.selection))
      if (values?.length) {
        const evidence = brief.evidence[key as keyof typeof brief.evidence];
        rows.push([
          title(dimensionNames[key] ?? key),
          `${values.join(", ")}${evidence ? ` (${evidence})` : ""}`,
        ]);
      }
    if (brief.settled.length)
      rows.push(["Won't ask again", brief.settled.map((k) => dimensionNames[k] ?? k).join(", ")]);
  }
  if (finder) {
    if (finder.query) rows.push(["Looking for", finder.query]);
    for (const [key, values] of Object.entries(finder.selection))
      if (values?.length) rows.push([`Tool ${key}`, values.join(", ")]);
  }
  if (draft) {
    for (const [key, values] of Object.entries(draft.filters))
      if (values?.length)
        rows.push([
          title(dimensionNames[key] ?? key),
          `${values.length > 4 ? `${values.slice(0, 4).join(", ")} +${values.length - 4}` : values.join(", ")}${draft.assumed?.includes(key as never) ? " (assumed)" : ""}`,
        ]);
    rows.push(["Years", draft.years.length ? draft.years.join(", ") : "all published"]);
  }
  return rows;
}

function Section({
  heading,
  count,
  children,
}: {
  heading: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="pane-section">
      <h4>
        {heading}
        {count !== undefined && <span>{count}</span>}
      </h4>
      {children}
    </section>
  );
}

/**
 * How one reply came about, sorted by what a reader wants to know: what went wrong, what was
 * understood from the message, what rules filled in, what was not mentioned, and what is
 * remembered for the next message. Each understood value opens to show its evidence.
 */
export function Inspector({
  message,
  input,
  onClose,
}: {
  message?: Message;
  input?: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const reply = message?.reply;
  const trace = reply?.trace ?? [];
  const errors = trace.filter((d) => outcomeOf(d) === "error");
  const doubts = trace.filter((d) => ["unsure", "overruled"].includes(outcomeOf(d)));
  const understood = trace.filter(
    (d) => d.source !== "policy" && outcomeOf(d) === "accepted" && d.choice,
  );
  const rules = trace.filter((d) => d.source === "policy" && outcomeOf(d) === "accepted");
  const unmentioned = trace.filter((d) => outcomeOf(d) === "none");
  const model = trace.find((d) => d.model)?.model;
  const memory = message ? memoryRows(message) : [];
  // Errors usually share one cause (the classifier is down), so they read as one line.
  const errorGroups = new Map<string, Decision[]>();
  for (const d of errors) {
    const key = d.error ?? "No valid answer came back.";
    errorGroups.set(key, [...(errorGroups.get(key) ?? []), d]);
  }
  return (
    <aside className="inspector" aria-label="Behind this answer">
      <div className="pane-head">
        <h2>Behind this answer</h2>
        {reply && (
          <button
            className="icon-button"
            title="Copy the reply as JSON"
            aria-label="Copy the reply as JSON"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(JSON.stringify({ input, ...reply }, null, 2))
                .then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
            }}
          >
            <Icon name={copied ? "check" : "copy"} />
          </button>
        )}
        <button className="icon-button" title="Close" aria-label="Close panel" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {!reply ? (
        <div className="pane-empty">
          <Icon name="sparkle" />
          <p>Nothing to show yet</p>
          <small>
            Send a message. This panel then explains how the reply was put together: what was
            understood, what was assumed, and why.
          </small>
        </div>
      ) : (
        <div className="pane-body">
          <section className="pane-intro">
            {input && (
              <>
                <span className="pane-label">You asked</span>
                <p className="quoted">{input}</p>
              </>
            )}
            <p className="pane-meta">
              {[`${understood.length} understood`, `${rules.length} by rule`]
                .concat(
                  errors.length + doubts.length ? `${errors.length + doubts.length} unclear` : [],
                )
                .join(" · ")}
              {reply.ms !== undefined && ` · ${reply.ms} ms`}
            </p>
          </section>

          {(errors.length > 0 || doubts.length > 0) && (
            <Section heading="Needs a look" count={errors.length + doubts.length}>
              {[...errorGroups].map(([error, group]) => (
                <div className="alert" key={error}>
                  <Icon name="alert" />
                  <p>
                    <strong>
                      The classifier could not decide the{" "}
                      {list(group.map((d) => d.subject ?? "decision"))}.
                    </strong>
                    <small>{error}</small>
                  </p>
                </div>
              ))}
              {doubts.length > 0 && (
                <ul className="fact-list">
                  {doubts.map((d, i) => (
                    <Fact key={`${message!.id}-doubt-${i}`} decision={d} open />
                  ))}
                </ul>
              )}
            </Section>
          )}

          <Section heading="Understood from your message" count={understood.length}>
            {understood.length ? (
              <ul className="fact-list">
                {understood.map((d, i) => (
                  <Fact key={`${message!.id}-fact-${i}`} decision={d} />
                ))}
              </ul>
            ) : (
              <p className="pane-muted">Nothing was read from the message itself.</p>
            )}
          </Section>

          {rules.length > 0 && (
            <Section heading="Filled in by rules" count={rules.length}>
              <ul className="fact-list">
                {rules.map((d, i) => (
                  <Fact key={`${message!.id}-rule-${i}`} decision={d} />
                ))}
              </ul>
            </Section>
          )}

          {unmentioned.length > 0 && (
            <Section heading="Not mentioned">
              <div className="chips">
                {unmentioned.map((d, i) => (
                  <span key={i} title={d.reason}>
                    {subjectOf(d)}
                  </span>
                ))}
              </div>
            </Section>
          )}

          {memory.length > 0 && (
            <details className="memory">
              <summary>
                <Icon name="chevronDown" className="chevron" />
                Remembered for your next message
              </summary>
              <dl>
                {memory.map(([key, value], i) => (
                  <div key={i}>
                    <dt>{key}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}

          <p className="pane-foot">
            {model ? `The classifier (${model})` : "The classifier"} only picks from fixed lists;
            every sentence in the reply is written by the assistant's code.
          </p>
        </div>
      )}
    </aside>
  );
}
