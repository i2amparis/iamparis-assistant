/** Opaque per-browser session id; the server only returns conversations created with it. */
function session() {
  const key = "iamparis-assistant-session";
  try {
    const saved = localStorage.getItem(key);
    if (saved) return saved;
    const created = crypto.randomUUID();
    localStorage.setItem(key, created);
    return created;
  } catch {
    return (memory ??= crypto.randomUUID());
  }
}
let memory: string | undefined;

/** Send a same-origin API request and surface the server's bounded error message. */
export async function request<T>(path: string, body?: unknown): Promise<T> {
  const headers = { "X-IAMPARIS-Session": session() };
  const response = await fetch(
    `/api${path}`,
    body === undefined
      ? { headers }
      : {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "The request failed.");
  return data as T;
}
