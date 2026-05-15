# Built-in workflow templates ship as inline YAML in TypeScript

Symphonika ships four built-in workflow templates (`builtin:single-agent-pr`,
`builtin:plan-tdd-pr`, `builtin:autofix-until-clean`, `builtin:merge-when-green`) as conveniences
over the repo-local template machinery introduced in ADR 0045 and SPEC §"Built-In Templates".
Built-ins are not a separate runtime path: they expand through the same `loadWorkflowTemplate`
loader, `expandWorkflowTemplateUse` interpolation, state-prefixing, and exit-mapping rules as
repo-local templates. The only difference is where the YAML comes from.

Four design choices follow.

First, **built-in template YAML lives as inline string constants in `src/builtin-templates.ts`**
rather than as bundled `.yml` files. `tsconfig.build.json` excludes non-`.ts` files from its
`src` rootDir → `dist` outDir mapping, so adding a `src/templates/*.yml` tree would require a
separate copy step in the build pipeline. The inline-string approach has zero build-pipeline
impact, keeps the contents directly verifiable by `tsc`, and mirrors the pattern that
`tests/workflow.test.ts` already uses when constructing workflow YAML inline via
`[...].join("\n")`. The cost is editor ergonomics (no YAML syntax highlighting inside TS string
literals), which is small relative to the four templates this set contains.

Second, **built-ins resolve by prefix on the existing `template:` field**: a workflow declares
`template: builtin:<name>` exactly the same way it declares `template: ./local.yml`.
`loadWorkflowTemplate` branches on the `builtin:` prefix as its first statement, *before* any
`path.resolve` or `isPathInside` check, returning a `ParsedWorkflowTemplate` whose `path` field
is the literal `builtin:<name>` sentinel. That sentinel flows through `templateFiles` and into
the `workflow validate` / `workflow explain` output unchanged, so operators see
`template files: builtin:single-agent-pr` and can distinguish built-in fragments from repo-local
ones without a new provenance field.

Third, **repositories override a built-in by swapping the reference**, not by name-shadowing.
A repository that wants different behavior for `single-agent-pr` writes a local file at
`.symphonika/workflow-templates/single-agent-pr.yml` and changes its workflow's `template:`
field from `builtin:single-agent-pr` to that path. There is no precedence rule and no auto-
shadowing of built-in names by local files; resolution stays explicit. An override-equivalence
test in `tests/workflow.test.ts` pins that the two references produce byte-identical expanded
state graphs when the local file contains the registry's YAML, which is what the SPEC
"repositories can replace built-ins with local templates without changing runtime behavior"
acceptance requires.

Fourth, **`autofix-until-clean` is predicate-bounded, not count-bounded**. The FSM has no
iteration-counter primitive (ADRs 0047 and 0048 deliberately omit one), so the built-in cannot
declare "loop at most N times." The loop's `waiting` state transitions to `done` when
`checks: success` AND `unresolved_review_threads: 0`, to `autofix` when there is one unresolved
review thread, and to `failed` when `checks: failure`. The project-wide
`pull_requests.maxReviewDispatchesPerPr` cap belongs to the separate PR follow-up loop in
`runPullRequestFollowup` and does *not* bound the FSM autofix re-entry — operators who need a
hard ceiling override the built-in with a local template, or cancel the waiting run.
`builtin:merge-when-green` similarly does *not* inherit `pull_requests.merge.method`: the
template's `method` input defaults to the string `"squash"` (matching the policy default), and
operators who run with a different `policy.merge.method` use a local template override. The
alternative — interpolating an empty string and relying on `coerceMergeMethod("")` returning
`undefined` so policy can fall back — was rejected because
`validateWorkflowTemplateInputValue` rejects empty strings outright and because an opaque
`method: ""` in the explained graph is less obvious than an explicit `squash` default.

The reserved prefix `builtin:` joins `sym:` (label namespace, ADR 0024) as a Symphonika-owned
namespace. There is no collision today but new template names should avoid both prefixes for
forward compatibility.
