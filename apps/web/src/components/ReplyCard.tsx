import { useState } from "react";
import type { Reply, TurnInput } from "../../../server/src/shared/types.ts";

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

/** Render a deterministic answer, searchable current choices, or a validated data preview. */
export function ReplyCard({
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
  const options =
    reply.options?.filter((o) =>
      `${o.label} ${o.detail ?? ""}`.toLowerCase().includes(search.toLowerCase()),
    ) ?? [];
  return (
    <>
      {reply.title && <h3>{reply.title}</h3>}
      <p className="reply-text">{reply.text}</p>
      {reply.source && <small className="source">Source: {reply.source}</small>}
      {reply.filters && (
        <dl className="filters">
          {Object.entries(reply.filters).map(([key, values]) => (
            <div key={key}>
              <dt>
                {({ workspace_code: "Study", modelName: "Model" } as Record<string, string>)[key] ??
                  key}
              </dt>
              <dd>{values?.join(" · ")}</dd>
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
      {reply.url && (
        <a className="link-button" href={reply.url} target="_blank" rel="noreferrer">
          {reply.plan ? "Open Analysis" : "Open IAMPARIS page"} ↗
        </a>
      )}
      {reply.plan && (
        <>
          <div className="export-actions">
            <button onClick={() => download(reply.plan!.graphConfig, "iamparis-analysis.json")}>
              Download analysis configuration ↓
            </button>
            <button onClick={() => download(reply.plan, "iamparis-data.json")}>
              Download data ↓
            </button>
          </div>
          <small className="source">
            Validated {new Date(reply.plan.validatedAt).toLocaleString()} · {reply.plan.rows.length}{" "}
            series · {reply.plan.years.length} published years
          </small>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Scenario</th>
                  <th>Unit</th>
                  {reply.plan.years.map((y) => (
                    <th key={y}>{y}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {reply.plan.rows.slice(0, 40).map((r, i) => (
                  <tr key={i}>
                    <td>{r.scenario}</td>
                    <td>{r.unit}</td>
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
          {reply.plan.rows.length > 40 && (
            <small>Preview shows 40 series. Download contains every matching series.</small>
          )}
        </>
      )}
      {!!reply.options?.length && (
        <div className="choices">
          {reply.options.length > 8 && (
            <input
              aria-label="Search available options"
              placeholder={`Search ${reply.options.length} available options…`}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setVisible(30);
              }}
              disabled={!active}
            />
          )}
          <div className="option-list">
            {options.slice(0, visible).map((o) => (
              <button
                key={o.id}
                disabled={!active}
                title={o.detail}
                onClick={() => send({ token: reply.token!, option: o.id })}
              >
                {o.label}
                <span>↗</span>
              </button>
            ))}
          </div>
          {options.length > visible && (
            <button disabled={!active} onClick={() => setVisible((n) => n + 50)}>
              Show more ({options.length - visible})
            </button>
          )}
          {!options.length && (
            <small>No matching option. Try a broader search or change an earlier filter.</small>
          )}
        </div>
      )}
    </>
  );
}
