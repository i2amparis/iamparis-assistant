// Build data/studies.json: every IAMPARIS study with the sector / region / topic / project facets
// the Results page filters on (https://iamparis.eu/results).
//
// The facets are not re-implemented here. This script imports the frontend's own pure modules
// (config/studyTaxonomy.js, utils/data/studyFacets.js, utils/data/studyView.js,
// data/studyMetadata.js) and feeds them the same two inputs the Results page loads: the CMS
// workspace list and each study's distinct regions, variables, models and scenarios from the
// results API. The assistant therefore filters exactly what the page filters.
//
//   node scripts/build_study_catalogue.mjs [path-to-i2amparis-frontend]
//
// Rerun when studies are added, or when the frontend's taxonomy or editorial metadata changes.
import { registerHooks } from "node:module";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const frontend = resolve(process.argv[2] ?? "../../i2amparis-frontend");
const lib = resolve(frontend, "src/lib");
if (!existsSync(resolve(lib, "utils/data/studyView.js"))) {
  console.error(`No IAMPARIS frontend at ${frontend}. Pass its path as the first argument.`);
  process.exit(1);
}
// The frontend imports through SvelteKit's `$lib` alias; resolve it to the source folder.
registerHooks({
  resolve(specifier, context, next) {
    return specifier.startsWith("$lib/")
      ? next(pathToFileURL(resolve(lib, specifier.slice(5))).href, context)
      : next(specifier, context);
  },
});
const at = (path) => import(pathToFileURL(resolve(lib, path)).href);
const { buildStudyCard } = await at("utils/data/studyView.js");
const { getStudyMetadata, STUDY_STATUS } = await at("data/studyMetadata.js");
const { SECTORS, TAGS, TAG_GROUPS, EU_MEMBERS } = await at("config/studyTaxonomy.js");

const CMS = process.env.IAM_CMS_URL || "https://cms.iamparis.eu";
const API = process.env.IAM_RESULTS_URL || "https://api.iamparis.eu";

async function json(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}
const distinct = async (column, code) =>
  (
    await json(`${API}/results/distinct`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ column, workspace_code: [code] }),
    })
  ).data
    .filter((value) => value != null && value !== "")
    .map(String);

// The same fields the Results page loads (directus/projects.js#getAllWorkspacesWithProjects).
const fields = [
  "id",
  "title",
  "description",
  "slug",
  "internal_name",
  "project_id.projects_id.slug",
  "project_id.projects_id.name",
].join(",");
const workspaces = (await json(`${CMS}/items/workspaces?limit=-1&fields=${fields}`)).data;

const studies = [];
for (const workspace of workspaces) {
  const projects = (workspace.project_id ?? [])
    .map((link) => link?.projects_id)
    .filter((project) => project?.slug && project?.name)
    .map((project) => ({ id: project.slug, label: project.name }));
  // The Results page lists a study under its projects; one without a project is not shown.
  if (!workspace.slug || !projects.length) continue;
  const code = workspace.internal_name;
  const [regions, variables, models, scenarios] = code
    ? await Promise.all(
        ["region", "variable", "modelName", "scenario"].map((column) =>
          distinct(column, code).catch(() => []),
        ),
      )
    : [[], [], [], []];
  const profile =
    regions.length || variables.length || models.length || scenarios.length
      ? { regions, variables, models, scenarios }
      : null;
  const card = buildStudyCard(workspace, profile);
  const editorial = getStudyMetadata(workspace.slug);
  studies.push({
    code: code ?? workspace.slug,
    slug: workspace.slug,
    title: workspace.title,
    summary: String(workspace.description ?? "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
    path: `/results/${projects[0].id}/${workspace.slug}/policy_questions`,
    sector: card.facets.sectors.map((f) => f.id),
    region: card.facets.regions.map((f) => f.id),
    tag: card.facets.tags.map((f) => f.id),
    project: projects.map((p) => p.id),
    questions: editorial.research_questions ?? [],
    status: editorial.status ? STUDY_STATUS[editorial.status.level]?.label : undefined,
    models: models.length,
    search: card.search,
    labels: Object.fromEntries([
      ...card.facets.regions.map((f) => [`region:${f.id}`, f.label]),
      ...card.facets.tags.map((f) => [`tag:${f.id}`, f.label]),
      ...projects.map((p) => [`project:${p.id}`, p.label]),
    ]),
  });
  console.log(
    `${(code ?? workspace.slug).padEnd(40)} ${card.facets.sectors.map((f) => f.id).join(",")} | ${card.facets.regions.map((f) => f.id).join(",")} | ${card.facets.tags.length} topics`,
  );
}

// One label per facet value; sectors and topic groups keep the taxonomy's display order.
const labels = Object.assign({}, ...studies.map((s) => s.labels));
const used = (key) => [...new Set(studies.flatMap((s) => s[key]))];
const lead = ["global", "eu"];
const rank = (id) => (lead.includes(id) ? lead.indexOf(id) : lead.length);
const catalogue = {
  _comment:
    "Generated by scripts/build_study_catalogue.mjs from the IAMPARIS frontend's study taxonomy, the CMS workspace list and the results API. Do not edit by hand: change the frontend's taxonomy or studyMetadata.js and rebuild.",
  generated_on: new Date().toISOString().slice(0, 10),
  source: "https://iamparis.eu/results",
  facets: {
    sector: SECTORS.filter((s) => used("sector").includes(s.id)).map((s) => ({
      id: s.id,
      label: s.label,
    })),
    region: used("region")
      // `eu` marks member states, so a search for one can be widened to EU-wide studies.
      .map((id) => ({
        id,
        label: labels[`region:${id}`],
        ...(EU_MEMBERS.has(id.replace(/-/g, " ")) ? { eu: true } : {}),
      }))
      .sort((a, b) => rank(a.id) - rank(b.id) || a.label.localeCompare(b.label)),
    tag: used("tag")
      .map((id) => ({
        id,
        label: labels[`tag:${id}`],
        group: TAG_GROUPS.find((g) => g.id === TAGS.find((t) => t.id === id)?.group)?.label,
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    project: used("project").map((id) => ({ id, label: labels[`project:${id}`] })),
  },
  studies: studies.map(({ labels: _labels, ...study }) => study),
};
writeFileSync(
  new URL("../data/studies.json", import.meta.url),
  `${JSON.stringify(catalogue, null, 2)}\n`,
);
console.log(`\n${studies.length} studies written to data/studies.json`);
