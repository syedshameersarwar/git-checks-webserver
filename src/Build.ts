import { CloudBuildClient } from "@google-cloud/cloudbuild";
import { Octokit } from "@octokit/rest";
import { resolve } from "path";
import { abortCheckRun } from "./Checks";
import { processLogs } from "./Utils";
import { Build, FinishedBuild, BuildStep, RepoStatus } from "./Interfaces";

export const triggerBuild = async (
  config: Build,
  bucket: string,
  object: string
) => {
  const source = {
    storageSource: {
      bucket,
      object,
    },
  };
  const logsBucket = bucket;
  config = normalizeBuildConfig({ ...config, source, logsBucket });
  let triggerStatus: {
    triggered: boolean;
    build?: Build;
    cloudBuild?: any;
  } = { triggered: false };
  let retry = 0;

  console.log("Build Configuration: ", config);
  console.log("Sending build request to gcb...");
  while (true) {
    try {
      const cloudBuild = new CloudBuildClient({
        projectId: process.env.PROJECT_ID,
        keyFilename: resolve(__dirname, process.env.GCS_SECRET!),
      });
      const [operationObj]: any = await cloudBuild.createBuild({
        projectId: process.env.PROJECT_ID,
        build: { ...config },
      });
      const {
        metadata: { build },
      } = operationObj!;
      console.log(`Build Triggered, with id: ${build.id}`);
      triggerStatus.triggered = true;
      triggerStatus = { ...triggerStatus, build, cloudBuild };
      return triggerStatus;
    } catch (err) {
      console.error(err);
      retry += 1;
      if (retry > 5) {
        console.log(
          `${retry} failed attempts for triggering the build.Returning...`
        );
        return triggerStatus;
      }
    }
  }
};

export const exitBuild = async (
  build: FinishedBuild,
  repoStatus: RepoStatus,
  installationClient: Octokit,
  owner: string,
  repo: string,
  name: string,
  check_run_id: number
) => {
  try {
    const logsStatus = await processLogs(build);
    if (!logsStatus!.downloaded)
      return abortCheckRun(
        repoStatus,
        installationClient,
        owner,
        repo,
        name,
        check_run_id,
        true
      );

    const { steps, status, logUrl } = build;
    const annotations = steps.map((s: BuildStep, i) => ({
      path: repoStatus.yamlFile!,
      start_line: repoStatus.stepLines![i],
      end_line: repoStatus.stepLines![i],
      annotation_level:
        s.status === "QUEUED"
          ? ("warning" as const)
          : s.status === "SUCCESS"
          ? ("notice" as const)
          : ("failure" as const),
      title: s.name,
      message: `${s.status}, ${
        s.status === "QUEUED"
          ? "This step is not executed"
          : "Logs are available as raw output."
      }`,
      raw_details: logsStatus!.logs![i] || "",
    }));

    const summary = getBuildSummary(build);
    let conclusion:
      | "success"
      | "failure"
      | "cancelled"
      | "timed_out"
      | "action_required"
      | "neutral"
      | undefined;
    if (status === "SUCCESS") conclusion = "success";
    else if (
      status === "FAILURE" ||
      status === "INTERNAL_ERROR" ||
      status === "EXPIRED"
    )
      conclusion = "failure";
    else if (status === "CANCELLED") conclusion = "cancelled";
    else if (status === "TIMEOUT") conclusion = "timed_out";

    await installationClient.checks.update({
      owner,
      repo,
      check_run_id,
      conclusion,
      details_url: logUrl,
      output: {
        title: name,
        summary,
        annotations,
        text: `${name} alpha version: 0.60`,
      },
    });
  } catch (err) {
    console.error(err);
    return abortCheckRun(
      repoStatus,
      installationClient,
      owner,
      repo,
      name,
      check_run_id,
      true
    );
  }
};

export const getBuildSummary = (build: FinishedBuild) => {
  let summary: string;
  summary = `#### ID: [${build.id}](${build.logUrl})\n`;
  summary += `##### Status: ${build.status}\n`;
  const created_at = new Date(
    build.createTime!.seconds * 1000 +
      Math.round(build.createTime.nanos / 1000000)
  ).toISOString();
  summary += `##### Created At: ${created_at}\n`;
  if (build.startTime) {
    const started_at = new Date(
      build.startTime.seconds * 1000 +
        Math.round(build.startTime.nanos / 1000000)
    ).toISOString();
    summary += `##### Started At: ${started_at}\n`;
  }
  if (build.finishTime) {
    const ended_at = new Date(
      build.finishTime.seconds * 1000 +
        Math.round(build.finishTime.nanos / 1000000)
    ).toISOString();
    summary += `##### Ended At: ${ended_at}\n`;
  }
  summary += "\n\n";
  summary += "### Steps\n";
  summary += "| status             | name                         | time |\n";
  summary += "|--------------------|------------------------------|------|\n";
  build.steps.forEach((s, i) => {
    const status = `|${
      s.status === "SUCCESS"
        ? ":heavy_check_mark:"
        : s.status === "QUEUED"
        ? ":warning:"
        : ":x:"
    }`;
    const name = `|\`${s.name}\`|`;
    let time;
    if (s.timing) {
      const start =
        s.timing.startTime.seconds * 1000 +
        Math.round(s.timing.startTime.nanos / 1000000);
      const end =
        s.timing.endTime.seconds * 1000 +
        Math.round(s.timing.endTime.nanos / 1000000);
      const seconds = (end - start) / 1000;
      if (seconds >= 60) {
        const minutes = (seconds / 60) % 60;
        time = `${Math.round(minutes)} m|`;
      } else time = `${Math.round(seconds)} s|`;
    } else time = "-|";
    summary += status + name + time + "\n";
  });
  summary += "<br/>\n";
  if (build.results.images.length > 0) {
    summary += "### Images";
    build.results.images.forEach(
      (img, i) => (summary += `\n${i + 1} \`${img.name}\``)
    );
  }
  return summary;
};

const normalizeBuildConfig = (buildConifg: Build) => {
  if (Object.keys(buildConifg).includes("timeout")) {
    const timeString = buildConifg["timeout"]!.toString();
    let totalSeconds;
    if (timeString.includes(".")) totalSeconds = parseFloat(timeString);
    else totalSeconds = parseInt(timeString);
    const millis = totalSeconds * 1000;
    const seconds = Math.floor(millis / 1000);
    const nanos = (millis - seconds * 1000) * 1e6;
    buildConifg["timeout"] = { seconds, nanos };
  }
  buildConifg.options = {
    substitutionOption: "ALLOW_LOOSE",
  };
  return buildConifg;
};
