export const config = {
  confidence: 0.72,
  margin: 0.15,
  maxCandidates: 70,
  apiTimeout: 20000,
  maxResponseBytes: 12_000_000,
  resultsUrl: process.env.IAM_RESULTS_URL || "https://api.iamparis.eu",
  modelsUrl: process.env.IAM_MODELS_URL || "https://cms.iamparis.eu/items/models",
  model: process.env.TYPESAFE_MODEL || "jev-latest",
  /** Browser origins allowed to call the API: this app's own dev server and the IAMPARIS web app. */
  origins: list(
    process.env.ALLOWED_ORIGINS,
    "http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174",
  ),
  /** Host header values accepted; guards against DNS rebinding while the server stays local. */
  hosts: list(process.env.ALLOWED_HOSTS, "localhost,127.0.0.1,[::1]"),
};

function list(value: string | undefined, fallback: string) {
  return new Set(
    (value || fallback)
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  );
}
