import type { Message } from "../../../server/src/shared/types.ts";

/** Show the selected reply's exact candidate labels, accepted choices and model probabilities. */
export function Inspector({ message }: { message?: Message }) {
  const trace = message?.reply?.trace ?? [];
  return (
    <aside className="inspector">
      <div className="pane-title">
        <span>Decision inspector</span>
        <span className="tag">{trace.length} steps</span>
      </div>
      <p className="muted">Select a reply to inspect how its choices were made.</p>
      {trace.length === 0 && (
        <div className="inspector-empty">
          ◇<p>No model decisions to show.</p>
          <small>Explicit choices can proceed without Jev.</small>
        </div>
      )}
      {trace.map((decision, index) => (
        <details key={index} open={index === trace.length - 1} className="decision">
          <summary>
            <span>
              {index + 1}. {decision.source === "user" ? "Your selection" : "Jev selection"}
            </span>
            <small>{decision.ms} ms</small>
          </summary>
          <p>{decision.question}</p>
          {decision.error && <p className="notice">{decision.error}</p>}
          <div className="tag">{decision.choice ? "Accepted" : "Clarification needed"}</div>
          {[...decision.options]
            .sort(
              (a, b) => (decision.probabilities[b.id] ?? 0) - (decision.probabilities[a.id] ?? 0),
            )
            .map((option) => (
              <div
                className={`probability ${option.id === decision.choice ? "chosen" : ""}`}
                key={option.id}
              >
                <div>
                  <span>{option.label}</span>
                  <small>
                    {decision.probabilities[option.id] === undefined
                      ? "—"
                      : `${Math.round(decision.probabilities[option.id] * 100)}%`}
                  </small>
                </div>
                <progress max={1} value={decision.probabilities[option.id] ?? 0} />
              </div>
            ))}
        </details>
      ))}
    </aside>
  );
}
