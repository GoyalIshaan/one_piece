import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statfsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { obj } from "@earendil-works/pi-schema";
import { defineTool, denySandboxReads } from "@one-piece/core";
import { SWARM_AGENT } from "@one-piece/engine";
import { grade, loadTasks, runEval, TASKS_DIR } from "@one-piece/evals";
import { boardModule } from "@one-piece/module-board";
import { questionsModule } from "@one-piece/module-questions";
import { workspaceModule } from "@one-piece/module-workspace";
import { Router, PROVIDER_FACTORIES } from "@one-piece/router";
import { schedulerModule } from "@one-piece/scheduler";
import { homeDir, loadConfig } from "../../packages/cli/src/config.ts";

const root = resolve(process.env.LOCAL_CAMPAIGN_DIR ?? ".one_piece/evals/local-campaign-01");
const seed = 3317723;
const peers = 3;
const model = "gpt-6.2-sol";
const production = SWARM_AGENT;
const change = "When the task has a submission channel, choose a delivery owner immediately. As soon as one working end-to-end implementation passes your available checks, have its owner submit the actual artifact. Keep that receipt while other peers improve or challenge it. Replace the submission only after checking that the new version preserves requirements and improves the result. Leave enough time to act on a verified improvement.";
const prompts = { baseline: production, hillclimb: production + "\n\n" + change };
const tasks = loadTasks("full");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const save = (path, value) => {
	const tmp = path + ".tmp";
	writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
	renameSync(tmp, path);
};
mkdirSync(root, { recursive: true });
const design = {
	seed, peers, model, provider: "openai", reasoning: "low", budgetScale: 1,
	tasks: tasks.map(t => t.id),
	prompts: Object.fromEntries(Object.entries(prompts).map(([k,v]) => [k, { sha256: hash(v), text: v }])),
	selection: "Last explicit team nomination at deadline; first separately retained. Missing submission scores zero. No hidden feedback during play.",
	order: tasks.flatMap((task,i) => (i % 2 ? ["hillclimb", "baseline"] : ["baseline", "hillclimb"]).map(arm => ({task: task.id, arm}))),
};
const designFile = join(root, "design.json");
if (existsSync(designFile) && JSON.stringify(JSON.parse(readFileSync(designFile))) !== JSON.stringify(design)) throw Error("Frozen design changed");
if (!existsSync(designFile)) save(designFile, design);
const cfg = loadConfig(process.cwd(), ["openai"]);
const router = new Router({providers: [{ ...cfg.providers[0], models: {default: model}, offer: [] }],
	credentialsPath: join(homeDir(), "auth.json"), providerFactories: PROVIDER_FACTORIES,
	requestWindowDir: join(root, "provider-windows")});
await router.prepare();
if (!router.menu().length || !router.menu().every(m => m.provider === "openai" && m.id === model)) throw Error("Requested model unavailable");
const deliveryFiles = { "tsp-tour": ["tour.txt"], "wide-audit": ["answers.json"] };
function nominationModule(task, storeDir, revisions) {
	return {
		manifest: {name: "submission", version: "1", roles:["leaf"], tools:["submit_workspace"], summary:"Submit this task's implementation", contextCostTokens:120},
		prompt: () => "Your team's deliverable is its most recent explicit submission before the run ends. Any peer may call tools.submit_workspace({}) in terminal to freeze their own implementation for the hidden grader. You may replace it later. A missing submission earns zero.",
		tools: ({node,harness}) => [defineTool({
			name: "submit_workspace", description: "Submit this peer's current task files as the team's new deliverable. Returns a receipt. The hidden grader runs after the deadline.",
			parameters: obj({}), async execute() {
				const from = harness.workspaceOf(node.id);
				if (!from || !existsSync(from)) throw Error("Workspace unavailable");
				const dest = mkdtempSync(join(storeDir, "revision-"));
				const digests = [];
				function copy(path) {
					const src = join(from, path);
					if (!existsSync(src)) return;
					const info = lstatSync(src);
					if (info.isSymbolicLink()) throw Error("Submission contains a symbolic link");
					if (info.isDirectory()) {
						mkdirSync(join(dest,path), {recursive:true});
						for (const f of readdirSync(src).sort()) {
							if (![".git","__pycache__",".pytest_cache",".mypy_cache"].includes(f)) copy(join(path,f));
						}
					} else if (info.isFile()) {
						const data = readFileSync(src);
						writeFileSync(join(dest,path),data);
						digests.push([path, hash(data)]);
					}
				}
				for (const p of deliveryFiles[task] ?? [""]) copy(p);
				const receipt = {revision: revisions.length + 1, nodeId: node.id, sha256:hash(JSON.stringify(digests)), files:digests,
					snapshot:dest, ts:Date.now(), tokens:harness.store.events(harness.run().id,{types:["model.call"]}).reduce((sum,event)=>sum+Number(event.data.totalTokens||0),0)};
				revisions.push(receipt);
				save(join(storeDir,"receipts.json"),revisions);
				return JSON.stringify({revision: receipt.revision, sha256: receipt.sha256, files:digests.length});
			}
		})]
	};
}
for (const item of design.order) {
	const id = item.task + "-" + item.arm;
	const output = join(root,id+".json");
	if (existsSync(output)) continue;
	const fs = statfsSync(root);
	if (fs.bavail * fs.bsize < 90 * 1024 ** 2) throw Error("Less than 90 MiB free before " + id);
	const trial = mkdtempSync(join(root, id + "-"));
	const frozen = join(trial,"nominations");
	mkdirSync(frozen);
	const otherCampaignEntries = readdirSync(root)
		.map(name => join(root, name))
		.filter(path => path !== trial);
	const evalsDir = resolve(".one_piece/evals");
	const pastSuites = existsSync(evalsDir)
		? readdirSync(evalsDir, { withFileTypes: true }).filter(entry => entry.isDirectory())
			.map(entry => join(evalsDir, entry.name))
			.filter(path => path !== root && !root.startsWith(path + "/"))
		: [];
	denySandboxReads([frozen, ...otherCampaignEntries, ...pastSuites]);
	const revisions = [];
	const result = await runEval({suite:"full",taskIds:[item.task],dataDir:trial,router,fixtureSeed:seed,environment:{agents:peers},
		modules:()=>[questionsModule({deadlineMs:180000}),boardModule(),workspaceModule({maxCommandSeconds:180,defaultFileLines:80}),schedulerModule(cfg.pools),nominationModule(item.task,frozen,revisions)],
		profile:{questions:"active",board:"active",workspace:"active",scheduler:"active",submission:"active"},
		maxConcurrentAgents:cfg.maxConcurrentAgents,extraConfig:{thinkingLevel:"low",swarmAgentPrompt:prompts[item.arm]}, log:console.log});
	const hidden = join(result.dir,"private-inputs",item.task);
	const scores = new Map();
	const gradeRevision = (r) => {
		if (!r) return {score:0, passed:false, details:"No explicit submission"};
		if (!scores.has(r.sha256)) scores.set(r.sha256,grade(join(TASKS_DIR,item.task),hidden,r.snapshot));
		return scores.get(r.sha256);
	};
	const first = gradeRevision(revisions[0]);
	const final = gradeRevision(revisions.at(-1));
	save(output,{...item, seed, trial, report:result.reportPath, result:result.results[0], first, final, revisions});
	console.log("NOMINATED",id,first.score,final.score,"offline",result.results[0].score);
}
