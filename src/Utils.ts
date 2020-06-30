import { Storage } from "@google-cloud/storage";
import { readdir, createReadStream, readFileSync, unlinkSync } from "fs";
import { FinishedBuild } from "./Interfaces";
import { promisify } from "util";
import { resolve } from "path";
import { getKey } from "./Cache";
import readline from "readline";
import yaml from "js-yaml";
import tar from "tar";

const readDir = promisify(readdir);

const GCS_BUILDS_BUCKET = "gcs-test-build-artifacts";

export const processYaml = async (fullRepoName: string) => {
  const processStatus: {
    [key: string]: boolean | string | number[] | object;
  } = {
    processed: false,
  };
  const repoDir = fullRepoName.split("/")[1];
  try {
    const files = await readDir(resolve(__dirname, `../${repoDir}`));
    const yamlFiles = files.filter((f) =>
      ["yaml", "yml"].includes(f.split(".")[1])
    );
    if (yamlFiles.length === 0) {
      console.log("No yaml files found.");
      return processStatus;
    }

    const possibleConfigs = ["cloudbuild-pr.yaml", "cloudbuild-pr.yml"];
    let targetConfig;
    possibleConfigs.some((c) => {
      const found = yamlFiles.includes(c);
      if (found) targetConfig = c;
      return found;
    });

    if (!targetConfig) {
      console.log("Build configuration files not found.");
      return processStatus;
    }
    processStatus.yamlFound = true;

    const lineReader = readline.createInterface({
      input: createReadStream(
        resolve(__dirname, `../${repoDir}/${targetConfig}`)
      ),
    });

    let lineNumber = 1;
    let stepLines = [];
    for await (const line of lineReader) {
      if (line.substring(0, 7) === "- name:") stepLines.push(lineNumber);
      lineNumber += 1;
    }
    let json = yaml.safeLoad(
      readFileSync(resolve(__dirname, `../${repoDir}/${targetConfig}`), {
        encoding: "utf8",
      })
    );

    processStatus.yamlFile = targetConfig;
    processStatus.stepLines = stepLines;
    processStatus.configJson = json;
    if (stepLines.length === 0) return processStatus;

    console.log(`${targetConfig} Processed for build configuration.`);
    processStatus.processed = true;
    return processStatus;
  } catch (err) {
    console.log("Failed to process yaml file.");
    console.error(err);
    return processStatus;
  }
};

export const generateTar = async (
  repoFullName: string,
  installationId: string
) => {
  const repoName = repoFullName.split("/")[1];
  const reposObj: Array<{ [key: string]: string }> = JSON.parse(
    await getKey(`${installationId}:repositories`)
  );
  const TARGET_REPOS: { [key: string]: string } = {};
  reposObj.forEach((repoObj) => {
    const repoName = Object.keys(repoObj)[0];
    TARGET_REPOS[repoName] = repoObj[repoName];
  });
  const branch = TARGET_REPOS[repoFullName];
  const tarName = `${repoName}_${branch}.tar.gz`;
  const tarStatus: { created: boolean; tarName: string } = {
    created: false,
    tarName,
  };
  try {
    const files = await readDir(resolve(__dirname, `../${repoName}`));
    const targetFiles = files.filter((f) => !f.includes(".git"));
    process.chdir(resolve(__dirname, `../${repoName}`));
    await tar.c(
      {
        gzip: true,
        file: tarName,
      },
      targetFiles
    );
    console.log(`${tarName} created.`);
    tarStatus.created = true;
    process.chdir("../");
    return tarStatus;
  } catch (err) {
    console.log(`${tarName} creation failed.`);
    console.error(err);
    return tarStatus;
  }
};

export const uploadSourceTar = async (
  fullRepoName: string,
  tarFile: string
) => {
  const uploadStatus: { [key: string]: boolean | string } = { uploaded: false };
  const repoDir = fullRepoName.split("/")[1];
  const tarPath = resolve(__dirname, `../${repoDir}/${tarFile}`);
  try {
    const storage = new Storage({
      projectId: process.env.PROJECT_ID!,
      keyFilename: resolve(__dirname, process.env.GCS_SECRET!),
    });

    const [buckets] = await storage.getBuckets();
    const exists = buckets.some((b) => b.name === GCS_BUILDS_BUCKET);
    if (!exists) {
      console.log(`${GCS_BUILDS_BUCKET} not found.Creating it...`);
      await storage.createBucket(GCS_BUILDS_BUCKET);
    } else console.log(`${GCS_BUILDS_BUCKET} Found.`);

    console.log(`Uploading ${tarFile} on ${GCS_BUILDS_BUCKET}`);
    await storage.bucket(GCS_BUILDS_BUCKET).upload(tarPath, {
      gzip: true,
      metadata: {
        cacheControl: "no-cache",
      },
    });

    uploadStatus.uploaded = true;
    uploadStatus.bucket = GCS_BUILDS_BUCKET;
    uploadStatus.bucketObject = tarFile;
    uploadStatus.objectURI = `gs://${GCS_BUILDS_BUCKET}/${tarFile}`;
    console.log(`${tarFile} uploaded to ${GCS_BUILDS_BUCKET}`);
    return uploadStatus;
  } catch (err) {
    console.log(`${tarFile} failed to upload on ${GCS_BUILDS_BUCKET} bucket.`);
    console.error(err);
    return uploadStatus;
  }
};

export const processLogs = async (build: FinishedBuild) => {
  const remoteFile = `log-${build.id}.txt`;
  const destination = resolve(__dirname, `../${remoteFile}`);
  const logsStatus: { downloaded: boolean; logs?: string[] } = {
    downloaded: false,
  };
  try {
    let storage, retry;
    retry = 0;
    while (true) {
      try {
        storage = new Storage({
          projectId: process.env.PROJECT_ID,
          keyFilename: resolve(__dirname, process.env.GCS_SECRET!),
        });

        await storage
          .bucket(build.logsBucket)
          .file(remoteFile)
          .download({ destination });
        break;
      } catch (err) {
        retry += 1;
        if (retry > 5) {
          console.log(
            `Too many retries for downloading ${remoteFile}.Returning...`
          );
          return;
        }
      }
    }
    logsStatus.downloaded = true;
    const lineReader = readline.createInterface({
      input: createReadStream(destination),
    });

    let stepLogs: string[] = [];
    let stepTxt = "";
    for await (const line of lineReader) {
      stepTxt = `${stepTxt}${line}\n`;
      if (stepTxt.includes("Finished Step #")) {
        stepLogs.push(stepTxt);
        stepTxt = "";
      }
    }
    let reducedLogs: string[] = [];
    stepLogs.forEach((l) => {
      const byteSize = parseInt(
        (0.001 * (encodeURI(l).split(/%..|./).length - 1)).toString()
      );
      if (byteSize > 64) {
        const lines = l.split("\n");
        let newlines = [
          ...lines.slice(0, 100),
          "...\n...\nSkipping lines to fit 64kb size\n...\n...",
          ...lines.slice(Math.max(lines.length - 450, 0)),
        ];
        let logTxt = newlines.join("\n");
        reducedLogs.push(logTxt);
      } else reducedLogs.push(l);
    });
    logsStatus.logs = reducedLogs;
    try {
      await storage.bucket(build.logsBucket).file(remoteFile).delete();
    } catch (_) {
      console.log(`Failed to delete ${remoteFile} from ${build.logsBucket}`);
    }
    unlinkSync(destination);
    return logsStatus;
  } catch (err) {
    console.error(err);
    return logsStatus;
  }
};
