import { buildCli } from "../../src/cli.js";
import { runInitProject, type GitHubApi } from "../../src/doctor.js";

const githubApi: GitHubApi = {
  createLabel: () => Promise.resolve(),
  listLabels: () => Promise.resolve([]),
  validateRepositoryAccess: () => Promise.resolve({ ok: true })
};
const program = buildCli({
  registerSignalHandlers: false,
  runInitProject: (options) => runInitProject({ ...options, githubApi })
});

void program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
