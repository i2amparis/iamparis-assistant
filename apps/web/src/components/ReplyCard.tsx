import { useState } from "react";
import type { Reply, ResultRow, TurnInput } from "../../../server/src/shared/types.ts";

const site = "https://iamparis.eu";
const fieldLabels: Record<string, string> = {
  workspace_code: "Study",
  variable: "Variable",
  region: "Region",
  modelName: "Model",
  scenario: "Scenario",
};

function download(value: unknown, name: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The current choices: a few suggestions first, the rest behind "Other…" with search. */
function Choices({
  reply,
  active,
  send,
}: {
  reply: Reply;
  active: boolean;
  send: (input: TurnInput) => void;
}) {
  const [search, setSearch] = useState("");
  const [visible, setVisible] = useState(30);
  const [expanded, setExpanded] = useState(false);
  const all = reply.options ?? [];
  if (!all.length) return null;
  // Choices on an older reply have expired: keep what was offered readable, not clickable.
  if (!active)
    return (
      <p className="expired">
        Offered:{" "}
        {all
          .slice(0, 6)
          .map((o) => o.label)
          .join(" · ")}
        {all.length > 6 ? ` · +${all.length - 6} more` : ""}
      </p>
    );
  const featured = reply.featured && !expanded ? reply.featured : undefined;
  const searchable = !featured && all.length > 8;
  const options = all.filter((o) =>
    `${o.label} ${o.detail ?? ""}`.toLowerCase().includes(search.toLowerCase()),
  );
  const limit = featured ?? visible;
  return (
    <div className="choices">
      {searchable && (
        <input
          aria-label="Search available options"
          placeholder={`Search ${all.length} options…`}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setVisible(30);
          }}
        />
      )}
      <div className="option-list">
        {options.slice(0, limit).map((o) => (
          <button
            key={o.id}
            title={o.detail}
            onClick={() => send({ token: reply.token!, option: o.id })}
          >
            {/* Typing the number picks the option too. */}
            <span className="option-number">{all.indexOf(o) + 1}</span>
            <span className="option-text">
              {o.label}
              {o.detail && <small>{o.detail}</small>}
            </span>
          </button>
        ))}
        {featured && all.length > featured && (
          <button className="option-other" onClick={() => setExpanded(true)}>
            Other… ({all.length - featured})
          </button>
        )}
      </div>
      {!featured && options.length > visible && (
        <button className="text-button" onClick={() => setVisible((n) => n + 50)}>
          Show more ({options.length - visible})
        </button>
      )}
      {!options.length && <small>No matching option. Try a broader search.</small>}
    </div>
  );
}

/** Render a deterministic answer, a list of studies, current choices, or a validated data preview. */
export function ReplyCard({
  reply,
  active,
  send,
}: {
  reply: Reply;
  active: boolean;
  send: (input: TurnInput) => void;
}) {
  const assumed = reply.state?.draft?.assumed ?? [];
  // Label rows by whatever differs between them (models, scenarios, …).
  const varying = (["modelName", "scenario", "region", "variable"] as const).filter(
    (field) => new Set(reply.plan?.rows.map((row: ResultRow) => row[field])).size > 1,
  );
  const rowFields = varying.length ? varying : (["scenario"] as const);
  const pages = (reply.actions ?? []).flatMap((a) => (a.type === "navigate" ? [a] : []));
  return (
    <>
      {reply.title && <h3>{reply.title}</h3>}
      <p className={`reply-text ${reply.kind === "error" ? "notice" : ""}`}>{reply.text}</p>
      {reply.selection && reply.selection.length > 0 && (
        <div className="selection" aria-label="Active study filters">
          {reply.selection.map((facet) => (
            <span key={facet.key}>
              <em>{facet.label}</em>
              {facet.values.map((v) => v.label).join(" or ")}
            </span>
          ))}
        </div>
      )}
      {reply.studies ? (
        <div className="studies">
          {reply.studies.map((study) => (
            <a className="study" key={study.code} href={study.url} target="_blank" rel="noreferrer">
              <span className="study-project">
                {study.projects.join(" · ")}
                {study.status && <em>{study.status}</em>}
              </span>
              <strong>{study.title}</strong>
              <p>{study.summary}</p>
              {study.question && <p className="study-question">{study.question}</p>}
              <span className="chips">
                {study.facets.slice(0, 7).map((f) => (
                  <span key={`${f.key}:${f.id}`} className={f.matched ? "matched" : ""}>
                    {f.label}
                  </span>
                ))}
                {study.facets.length > 7 && <span>+{study.facets.length - 7}</span>}
              </span>
            </a>
          ))}
        </div>
      ) : (
        reply.facts &&
        reply.facts.length > 0 && (
          <ul className="facts">
            {reply.facts.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
        )
      )}
      {reply.filters && Object.keys(reply.filters).length > 0 && (
        <dl className="filters">
          {Object.entries(reply.filters).map(([key, values]) => (
            <div key={key}>
              <dt>{fieldLabels[key] ?? key}</dt>
              <dd>
                {values?.join(" · ")}
                {assumed.includes(key as never) && <em>assumed</em>}
              </dd>
            </div>
          ))}
          <div>
            <dt>Years</dt>
            <dd>
              {reply.years?.length
                ? `${reply.years[0]}${reply.years.length > 1 ? ` – ${reply.years.at(-1)}` : ""}`
                : "All published years"}
            </dd>
          </div>
        </dl>
      )}
      <div className="links">
        {pages.map((action) => (
          <a
            className="link-button"
            key={action.path}
            href={`${site}${action.path}`}
            target="_blank"
            rel="noreferrer"
          >
            {action.label} ↗
          </a>
        ))}
        {!pages.length && reply.url && (
          <a className="link-button" href={reply.url} target="_blank" rel="noreferrer">
            {reply.plan ? "Open Analysis" : "Open IAMPARIS page"} ↗
          </a>
        )}
      </div>
      {reply.plan && (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{rowFields.map((f) => fieldLabels[f]).join(" · ")}</th>
                  {reply.plan.years.map((y) => (
                    <th key={y}>{y}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {reply.plan.rows.slice(0, 40).map((r, i) => (
                  <tr key={i}>
                    <td>{rowFields.map((f) => r[f]).join(" · ")}</td>
                    {reply.plan!.years.map((y) => (
                      <td key={y}>
                        {r.years[y] === null
                          ? "—"
                          : (r.years[y]?.toLocaleString(undefined, { maximumFractionDigits: 3 }) ??
                            "—")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <small className="source">
            {reply.plan.rows[0]?.unit} · {reply.plan.rows.length} series · {reply.plan.years.length}{" "}
            published years · validated {new Date(reply.plan.validatedAt).toLocaleString()}
            {reply.plan.rows.length > 40 && " · first 40 shown, the download has all"}
          </small>
          <div className="export-actions">
            <button onClick={() => download(reply.plan, "iamparis-data.json")}>Data ↓</button>
            <button onClick={() => download(reply.plan!.graphConfig, "iamparis-analysis.json")}>
              GraphMaker configuration ↓
            </button>
          </div>
        </>
      )}
      <Choices reply={reply} active={active} send={send} />
      {reply.source && <small className="source">Source: {reply.source}</small>}
    </>
  );
}
