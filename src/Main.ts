import { requestCheckRunCreation, initiateBuild } from "./Checks";
import {
  insertRepo,
  deleteRepo,
  handleBranchCreation,
  handleBranchDeletion,
  deletePrFromCache,
} from "./Repo";
import { redisSlaveClient, deleteInstallation } from "./Cache";
import { AuthenticateRequest, Response } from "./Interfaces";

const eventHandler = (
  req: AuthenticateRequest,
  res: Response,
  next: (err: Error) => any
) => {
  switch (req.headers["x-github-event"]) {
    case "pull_request":
      generatePrResponse(req, res, next);
      return;
    case "check_run":
      generateCheckRunResponse(req, res, next);
      return;
    case "installation_repositories":
      generateInstallationRepoResponse(req, res, next);
      return;
    case "installation":
      generateInstallationResponse(req, res, next);
      return;
    case "create":
      generateCreateResponse(req, res, next);
      return;
    case "delete":
      generateDeleteResponse(req, res, next);
      return;
    default:
      return res.sendStatus(200);
  }
};

const generatePrResponse = async (
  req: AuthenticateRequest,
  res: Response,
  next: (err: Error) => any
) => {
  try {
    const { payload, installationClient } = req;
    switch (payload["action"]) {
      case "opened":
      case "reopened":
      case "synchronize":
        return redisSlaveClient.get(
          `${payload["installation"]["id"]}:repositories`,
          async (err, data) => {
            if (err) {
              console.error(err);
              return;
            }
            const repositories = JSON.parse(data);
            if (!repositories || !Array.isArray(repositories)) {
              console.log("Backend not initalized correctly.");
              return res.sendStatus(200);
            }
            const prBase = payload["pull_request"]!["base"];
            const baseRef = prBase["ref"];
            const baseRepo = prBase["repo"]["full_name"];
            for (const repoObj of repositories) {
              const repo = Object.keys(repoObj)[0];
              if (repo === baseRepo && repoObj[repo] === baseRef) {
                return (
                  await requestCheckRunCreation(payload, installationClient!)
                )(res)();
              }
            }
          }
        );
      case "closed":
        res.sendStatus(200);
        return (async () => await deletePrFromCache(payload))();
      default:
        return res.sendStatus(200);
    }
  } catch (err) {
    next(err);
  }
};

const generateCheckRunResponse = (
  req: AuthenticateRequest,
  res: Response,
  next: (err: Error) => any
) => {
  try {
    const { payload, installationClient, installationToken } = req;
    if (
      !(
        payload["check_run"]["app"]["id"].toString() ===
        process.env.GITHUB_APP_IDENTIFIER
      )
    )
      return res.sendStatus(401);
    switch (payload["action"]) {
      case "created":
        return (() => {
          console.log("Check Run created.");
          res.sendStatus(201);
          initiateBuild(payload, installationClient!, installationToken!);
        })();
      case "rerequested":
        return (async () =>
          (await requestCheckRunCreation(payload, installationClient!, true))(
            res
          )())();
      default:
        return res.sendStatus(200);
    }
  } catch (err) {
    next(err);
  }
};

const generateInstallationResponse = (
  req: AuthenticateRequest,
  res: Response,
  next: (err: Error) => any
) => {
  try {
    const { payload, installationClient } = req;
    switch (payload["action"]) {
      case "created":
        res.sendStatus(200);
        if (payload["repositories"].length > 0)
          return (async () => {
            await insertRepo(
              payload["repositories"],
              payload["installation"]["id"],
              installationClient!
            );
          })();
        return;
      case "deleted":
        res.sendStatus(200);
        return (async () => {
          console.log(`Perform deletion of ${payload["installation"]["id"]}`);
          await deleteInstallation();
        })();
      default:
        return res.sendStatus(200);
    }
  } catch (err) {}
};

const generateInstallationRepoResponse = (
  req: AuthenticateRequest,
  res: Response,
  next: (err: Error) => any
) => {
  try {
    const { payload, installationClient } = req;
    switch (payload["action"]) {
      case "added":
        res.sendStatus(200);
        return (async () =>
          await insertRepo(
            payload["repositories_added"],
            payload["installation"]["id"],
            installationClient!
          ))();
      case "removed":
        res.sendStatus(200);
        return (async () =>
          await deleteRepo(
            payload["repositories_removed"],
            payload["installation"]["id"]
          ))();
      default:
        return res.sendStatus(200);
    }
  } catch (err) {
    next(err);
  }
};

const generateCreateResponse = (
  req: AuthenticateRequest,
  res: Response,
  next: (err: Error) => any
) => {
  try {
    const { payload, installationClient } = req;
    switch (payload!["ref_type"]) {
      case "branch":
        res.sendStatus(200);
        return (async () =>
          await handleBranchCreation(
            payload.ref,
            payload.repository.full_name,
            payload.installation.id,
            installationClient!
          ))();
      default:
        return res.sendStatus(200);
    }
  } catch (err) {
    next(err);
  }
};

const generateDeleteResponse = (
  req: AuthenticateRequest,
  res: Response,
  next: (err: Error) => any
) => {
  try {
    const { payload, installationClient } = req;
    switch (payload["ref_type"]) {
      case "branch":
        res.sendStatus(200);
        return (async () =>
          await handleBranchDeletion(
            payload.ref,
            payload.repository.full_name,
            payload.installation.id,
            installationClient!
          ))();
      default:
        return res.sendStatus(200);
    }
  } catch (err) {}
};

export default eventHandler;
