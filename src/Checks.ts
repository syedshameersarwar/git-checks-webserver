import { Payload, Response, RepoStatus } from "./Interfaces";
import { Octokit } from "@octokit/rest";
import { processRepo, savePrInCache } from "./Repo";
import { triggerBuild, exitBuild } from "./Build";
import { setKey, expireKey, getKey } from "./Cache";

const CHECK_NAME = "GCB-Build";

export const requestCheckRunCreation = async (
  payload: Payload,
  installationClient: Octokit,
  rerequest = false
) => {
  const head_sha = !payload["check_run"]
    ? payload["pull_request"]!["head"]["sha"]
    : payload["check_run"]["head_sha"];

  if (payload["pull_request"]) (async () => await savePrInCache(payload))();

  if (!rerequest && (await getKey(head_sha))) {
    console.log("Requested check is already performed.");
    return (res: Response) => () => res.sendStatus(200);
  }

  return (res: Response) => () => {
    payload.head_sha = head_sha;
    res.sendStatus(200);
    create_check_run(payload, installationClient);
  };
};

export const create_check_run = async (
  payload: Payload,
  installationClient: Octokit
) => {
  try {
    const installationId = payload["installation"]!["id"];
    const [owner, repo] = payload["repository"]!["full_name"].split("/");
    const { head_sha } = payload;
    const name = CHECK_NAME;

    const {
      data: { id },
    } = await installationClient.checks.create({
      owner,
      repo,
      name,
      head_sha,
    });

    if (payload["action"] === "rerequested") {
      const oldCheckRunId = payload["check_run"]!["id"];
      let oldCheckPr: string = await getKey(
        `${installationId}:${oldCheckRunId}`
      );
      if (!oldCheckPr) {
        const allPullRequests = payload["check_run"]!["check_suite"][
          "pull_requests"
        ];
        for await (const pr of allPullRequests) {
          const prSubsitution: { [key: string]: string } = JSON.parse(
            await getKey(`${installationId}:${pr.id}`)
          );
          if (prSubsitution) {
            if (
              prSubsitution.REPO_NAME === pr["head"]["repo"]["name"] &&
              prSubsitution._HEAD_BRANCH === pr["head"]["ref"] &&
              prSubsitution._BASE_BRANCH === pr["base"]["ref"] &&
              prSubsitution._PR_NUMBER === pr["number"].toString()
            ) {
              oldCheckPr = `${installationId}:${pr.id}`;
              break;
            }
          }
        }
      }
      await setKey(`${installationId}:${id}`, oldCheckPr);
      console.log(
        `Associated PR with the check run {${installationId}:${id}}: ${oldCheckPr}`
      );
      let prCheckRuns: string[] = JSON.parse(
        await getKey(`${oldCheckPr}:checks`)
      );
      if (!prCheckRuns) prCheckRuns = [];
      prCheckRuns.push(`${installationId}:${id}`);
      await setKey(`${oldCheckPr}:checks`, JSON.stringify(prCheckRuns));
      console.log(
        `All check runs related to PR: {${oldCheckPr}}: `,
        prCheckRuns
      );
    }

    if (payload["pull_request"]) {
      const prId = payload["pull_request"]["id"];
      await setKey(`${installationId}:${id}`, `${installationId}:${prId}`);
      console.log(
        `Associated PR with the check run {${installationId}:${id}}: ${prId}`
      );
      let prCheckRuns: string[] = JSON.parse(
        await getKey(`${installationId}:${prId}:checks`)
      );
      if (!prCheckRuns) prCheckRuns = [];
      prCheckRuns.push(`${installationId}:${id}`);
      await setKey(
        `${installationId}:${prId}:checks`,
        JSON.stringify(prCheckRuns)
      );
      console.log(
        `All check runs related to PR: {${installationId}:${prId}}: `,
        prCheckRuns
      );
    }

    await setKey(head_sha, new Date().toISOString());
    await expireKey(head_sha, 24 * 10 * 60 * 60);
  } catch (err) {
    console.error(err);
  }
};

export const initiateBuild = async (
  payload: Payload,
  installationClient: Octokit,
  installationToken: string
) => {
  let repoStatus: RepoStatus = {};
  let substitutions: { [key: string]: string };
  const fullRepoName = payload["repository"]!["full_name"];
  const [owner, repo] = fullRepoName.split("/");
  const check_run_id = payload["check_run"]!["id"];
  const headBranch = payload["check_run"]!["check_suite"]["head_branch"];
  const name = payload["check_run"]!["name"];
  const installationId = payload["installation"]!["id"];

  console.log("Fetching substitutions from cache.");
  while (true) {
    const substitutionsKey = await getKey(`${installationId}:${check_run_id}`);
    if (!substitutionsKey) continue;
    substitutions = JSON.parse(await getKey(substitutionsKey));
    break;
  }
  console.log("Substitutions: ", substitutions);

  try {
    await installationClient.checks.update({
      owner,
      repo,
      check_run_id,
      name,
      status: "in_progress",
      started_at: new Date().toISOString(),
      output: {
        title: name,
        summary: "Changes are being processed by CI server.",
        text: `${name} alpha version: 0.60`,
      },
    });

    repoStatus = await processRepo(
      installationToken,
      fullRepoName,
      headBranch,
      installationId.toString()
    );

    if (!repoStatus.completed) {
      await abortCheckRun(
        repoStatus,
        installationClient,
        owner,
        repo,
        name,
        check_run_id
      );
      return;
    }

    let { configJson, bucket, bucketObject } = repoStatus;
    configJson = { ...configJson!, substitutions };
    let triggerStatus = await triggerBuild(configJson!, bucket!, bucketObject!);

    if (!triggerStatus!.triggered) {
      repoStatus.triggered = triggerStatus!.triggered;
      await abortCheckRun(
        repoStatus,
        installationClient,
        owner,
        repo,
        name,
        check_run_id
      );
      return;
    }
    let build: any = triggerStatus!.build!;
    let cloudBuild: any = triggerStatus!.cloudBuild!;

    while (true) {
      [build] = await cloudBuild.getBuild({
        projectId: process.env.PROJECT_ID,
        id: build.id,
      });
      const { status } = build;

      if (
        [
          "SUCCESS",
          "FAILURE",
          "INTERNAL_ERROR",
          "TIMEOUT",
          "CANCELLED",
          "EXPIRED",
        ].includes(status)
      )
        return await exitBuild(
          build,
          repoStatus,
          installationClient,
          owner,
          repo,
          name,
          check_run_id
        );

      const { id, createTime, startTime, logUrl } = build;

      let summary = `#### ID: [${id}](${logUrl})\n`;
      summary += `##### Status: ${status}\n`;
      const created_at = new Date(
        createTime.seconds * 1000 + Math.round(createTime.nanos / 1000000)
      ).toISOString();
      summary += `##### Created At: ${created_at}\n`;
      if (startTime) {
        const started_at = new Date(
          startTime.seconds * 1000 + Math.round(startTime.nanos / 1000000)
        ).toISOString();
        summary += `##### Started At: ${started_at}\n`;
      }

      await installationClient.checks.update({
        owner,
        repo,
        check_run_id,
        name,
        status: "in_progress",
        details_url: logUrl,
        output: {
          title: name,
          summary,
          text: `${name} alpha version: 0.60`,
        },
      });
      await new Promise((r) => setTimeout(r, 10000));
    }
  } catch (err) {
    console.error(err);
    await abortCheckRun(
      repoStatus,
      installationClient,
      owner,
      repo,
      name,
      check_run_id
    );
  }
};

export const abortCheckRun = async (
  status: RepoStatus,
  installationClient: Octokit,
  owner: string,
  repo: string,
  name: string,
  check_run_id: number,
  force = false
) => {
  try {
    const {
      fetched,
      merged,
      yamlFile,
      stepLines,
      tarCreated,
      uploaded,
      triggered,
    } = status!;
    let conclusion:
      | "success"
      | "failure"
      | "cancelled"
      | "timed_out"
      | "action_required"
      | "neutral"
      | undefined;
    let summary: string;
    if (force) {
      conclusion = "failure" as const;
      summary = "Internal Server Error.Check your CI server logs for details.";
    } else if (!fetched) {
      conclusion = "failure" as const;
      summary = "Internal Server Error.Check your CI server logs for details.";
    } else if (fetched && !merged) {
      conclusion = "action_required" as const;
      summary = "Changes can not be merged.";
    } else if (
      (!stepLines || !tarCreated || !uploaded || !triggered) &&
      yamlFile
    ) {
      conclusion = "failure" as const;
      summary = "Internal Server Error.Check your CI server logs for details.";
    } else {
      conclusion = "action_required" as const;
      summary = "Build configuration file not found.";
    }
    console.log(
      `Terminating check run: ${check_run_id}, with conclusion: ${conclusion}`
    );
    await installationClient.checks.update({
      owner,
      repo,
      check_run_id,
      name,
      conclusion,
      status: "completed",
      completed_at: new Date().toISOString(),
      output: {
        title: name,
        summary,
        text: `${name} alpha version: 0.60`,
      },
    });
  } catch (err) {
    console.error(err);
  }
};
