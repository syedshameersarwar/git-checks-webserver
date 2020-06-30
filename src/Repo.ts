import simpleGit from "simple-git/promise";
import { execSync } from "child_process";
import { Repository, Payload } from "./Interfaces";
import { Octokit } from "@octokit/rest";
import { existsSync } from "fs";
import { resolve } from "path";
import { getKey, setKey, deleteKeys } from "./Cache";
import { processYaml, generateTar, uploadSourceTar } from "./Utils";

const git = simpleGit();

export const insertRepo = async (
  repositories: Array<Repository>,
  installtaionId: string,
  installationClient: Octokit
) => {
  try {
    let existingRepos: Array<{ [key: string]: string | null }> = JSON.parse(
      await getKey(`${installtaionId}:repositories`)
    );
    if (!existingRepos) existingRepos = [];

    await Promise.all(
      repositories.map(async (repository) => {
        const { full_name } = repository;
        const [owner, repo] = full_name.split("/");
        const { data } = await installationClient.repos.listBranches({
          owner,
          repo,
        });
        const branches = data.map((branch) => branch.name);
        await setKey(full_name, JSON.stringify(branches));
        const repoObj: { [key: string]: string | null } = {};
        // hard coding for data repo, soon to be edited
        if (repo === "data") repoObj[full_name] = "dev";
        else repoObj[full_name] = null;
        existingRepos.push(repoObj);
      })
    );
    await setKey(
      `${installtaionId}:repositories`,
      JSON.stringify(existingRepos)
    );
    console.log("Pushed to database:", existingRepos);
    console.log(
      `Synchronize repositories for Installation ${installtaionId} at ${new Date().toISOString()} `
    );
  } catch (err) {
    console.error(err);
  }
};

export const deleteRepo = async (
  repositories: Array<Repository>,
  installationId: string
) => {
  try {
    let existingRepos: Array<{ [key: string]: string | null }> = JSON.parse(
      await getKey(`${installationId}:repositories`)
    );
    const deletedKeys: string[] = [];
    for (const repository of repositories) {
      const { full_name } = repository;
      deletedKeys.push(full_name);
      if (existingRepos)
        existingRepos = existingRepos.filter(
          (repoObj) => Object.keys(repoObj)[0] !== full_name
        );
    }
    // @ts-ignore: Incorrect definition in redis types for del command
    await deleteKeys(deletedKeys);
    if (existingRepos)
      await setKey(
        `${installationId}:repositories`,
        JSON.stringify(existingRepos)
      );
    console.log("Deleted from database:", deletedKeys);
    console.log(
      `Synchronize repositories for Installation ${installationId} at ${new Date().toISOString()} `
    );
  } catch (err) {
    console.error(err);
  }
};

export const handleBranchCreation = async (
  branch: string,
  fullRepoName: string,
  installationId: string,
  installationClient: Octokit
) => {
  try {
    const [owner, repo] = fullRepoName.split("/");
    const { data } = await installationClient.repos.listBranches({
      owner,
      repo,
    });
    const branches = data.map((branch) => branch.name);
    await setKey(fullRepoName, JSON.stringify(branches));
    console.log(
      `Added Branch ${branch} on ${fullRepoName}, for installation: ${installationId}`
    );
  } catch (err) {
    console.error(err);
  }
};

export const handleBranchDeletion = async (
  branch: string,
  fullRepoName: string,
  installationId: string,
  installationClient: Octokit
) => {
  try {
    const [owner, repo] = fullRepoName.split("/");
    const { data } = await installationClient.repos.listBranches({
      owner,
      repo,
    });
    const branches = data.map((branch) => branch.name);
    let existingRepos: Array<{ [key: string]: string | null }> = JSON.parse(
      await getKey(`${installationId}:repositories`)
    );
    let deleted = false;
    if (existingRepos)
      existingRepos.forEach((repoObj) => {
        const repoName = Object.keys(repoObj)[0];
        if (repoName === fullRepoName && repoObj[repoName] === branch) {
          repoObj[repoName] = null;
          deleted = true;
        }
      });
    await setKey(fullRepoName, JSON.stringify(branches));
    if (deleted)
      await setKey(
        `${installationId}:repositories`,
        JSON.stringify(existingRepos)
      );
    console.log(
      `Deleted Branch ${branch} on ${fullRepoName}, for installation: ${installationId}`
    );
  } catch (err) {
    console.error(err);
  }
};

export const processRepo = async (
  installationToken: string,
  fullRepoName: string,
  headBranch: string,
  installationId: string
) => {
  let repoArtifacts: { [key: string]: boolean | string | Object | number[] } = {
    completed: false,
  };
  try {
    const { merged, fetched } = await fetchRepo(
      installationToken,
      fullRepoName,
      headBranch,
      installationId
    );
    repoArtifacts = { ...repoArtifacts, merged, fetched };
    if (!merged) return repoArtifacts;

    const {
      processed,
      configJson,
      yamlFound,
      stepLines,
      yamlFile,
    } = await processYaml(fullRepoName);
    if (!processed) {
      if (!yamlFound) repoArtifacts.yamlFound = false;
      return repoArtifacts;
    }
    repoArtifacts = { ...repoArtifacts, configJson, yamlFile, stepLines };
    const { created, tarName } = await generateTar(
      fullRepoName,
      installationId
    );
    repoArtifacts.tarCreated = created;
    if (!created) return repoArtifacts;
    repoArtifacts.tarFile = tarName;

    const { uploaded, bucketObject, objectURI, bucket } = await uploadSourceTar(
      fullRepoName,
      tarName
    );
    repoArtifacts.uploaded = uploaded;
    if (!uploaded) return repoArtifacts;

    repoArtifacts = { ...repoArtifacts, bucketObject, objectURI, bucket };
    repoArtifacts.completed = true;
    return repoArtifacts;
  } catch (err) {
    console.error(err);
    return repoArtifacts;
  }
};

export const fetchRepo = async (
  installationToken: string,
  fullRepoName: string,
  headBranch: string,
  installationId: string
) => {
  const [owner, repo] = fullRepoName.split("/");
  const mergedStatus = { merged: false, fetched: false };
  let mergeRetry = 0;
  const reposObj: Array<{ [key: string]: string }> = JSON.parse(
    await getKey(`${installationId}:repositories`)
  );
  const TARGET_REPOS: { [key: string]: string } = {};
  reposObj.forEach((repoObj) => {
    const repoName = Object.keys(repoObj)[0];
    TARGET_REPOS[repoName] = repoObj[repoName];
  });
  while (true) {
    try {
      if (existsSync(resolve(__dirname, `../${repo}`))) {
        console.log(`Using cached ${fullRepoName}.`);
      } else {
        console.log(`Fetching ${fullRepoName}`);
        let retry = 0;
        while (true) {
          try {
            await git.clone(
              `https://x-access-token:${installationToken}@github.com/${fullRepoName}.git`
            );
            break;
          } catch (err) {
            retry += 1;
            if (retry > 5) {
              console.log("Too many tries for fetching repo.Returning...");
              return mergedStatus;
            }
          }
        }
        console.log("Fetched complete.");
      }
      await git.cwd(repo);
      await git.pull();
      await git.checkout(headBranch);
      await git.checkout(TARGET_REPOS[fullRepoName]);
      mergedStatus.fetched = true;
      await git.merge([headBranch]);
      console.log(`Merged ${headBranch} to ${TARGET_REPOS[fullRepoName]}.`);
      await git.cwd(process.cwd());
      mergedStatus.merged = true;
      return mergedStatus;
    } catch (err) {
      console.log(
        `Merged failed from ${headBranch} to ${TARGET_REPOS[fullRepoName]}.`
      );
      console.error(err.git ? err.git : err);
      console.log("Retrying...");
      mergeRetry += 1;
      if (mergeRetry > 5) {
        console.log(`Too many retries for merging repo.Returning...`);
        return mergedStatus;
      }
      await git.cwd(process.cwd());
      execSync(`rm -rf ${repo}`);
    }
  }
};

export const savePrInCache = async (payload: Payload) => {
  try {
    const installationId = payload["installation"]!["id"];
    const substitutions: { [key: string]: string } = {};
    const pullRequestId = payload["pull_request"]!["id"];
    substitutions.COMMIT_SHA = payload["pull_request"]!["head"]["sha"];
    substitutions.SHORT_SHA = substitutions.COMMIT_SHA.slice(0, 7);
    substitutions.REPO_NAME = payload["repository"]!["name"];
    substitutions.BRANCH_NAME = payload["pull_request"]!["base"]["ref"];
    substitutions.REVISION_ID = substitutions.COMMIT_SHA;
    substitutions._HEAD_BRANCH = payload["pull_request"]!["head"]["ref"];
    substitutions._BASE_BRANCH = substitutions.BRANCH_NAME;
    substitutions._PR_NUMBER = payload["pull_request"]!["number"].toString();
    // hardcoding substitution for data repo, need to be removed in future
    if (
      substitutions.REPO_NAME === "data" &&
      substitutions._BASE_BRANCH === "dev"
    )
      substitutions._BUCKET = "gs://project-central-repo";
    await setKey(
      `${installationId}:${pullRequestId}`,
      JSON.stringify(substitutions)
    );
    console.log(
      `Saved substitution ${installationId}:${pullRequestId}`,
      substitutions
    );
  } catch (err) {
    console.error(err);
  }
};

export const deletePrFromCache = async (payload: Payload) => {
  try {
    const installationId = payload["installation"]!["id"];
    const prId = payload["pull_request"]!["id"];
    const prKey = `${installationId}:${prId}`;
    const prChecks = JSON.parse(await getKey(`${prKey}:checks`));
    if (prChecks && Array.isArray(prChecks) && prChecks.length > 0)
      // @ts-ignore: Incorrect definition in redis types for del command
      await deleteKeys(prChecks);
    // @ts-ignore: Incorrect definition in redis types for del command
    await deleteKeys([`${prKey}:checks`, prKey]);
    console.log(`Deleted Pr: ${prKey}`);
  } catch (err) {
    console.error(err);
  }
};
