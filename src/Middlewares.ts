import WebhooksApi from "@octokit/webhooks";
import { Octokit } from "@octokit/rest";
import { retry } from "@octokit/plugin-retry";
import { createAppAuth } from "@octokit/auth-app";
import dotenv from "dotenv";
import fs from "fs";
import { resolve } from "path";
import { AuthenticateRequest, Response } from "./Interfaces";
dotenv.config({ path: resolve(__dirname, "./config/.env") });

const MyOctokit = Octokit.plugin(retry);
const webhooks = new WebhooksApi({
  secret: process.env.GITHUB_WEBHOOK_SECRET!,
});

export const verifyPayload = (
  req: AuthenticateRequest,
  res: Response,
  next: Function
) => {
  const payload = req.body;
  const signature = webhooks.sign(payload);
  const verified = webhooks.verify(payload, signature);
  req.payload = payload;
  return verified ? next() : res.sendStatus(401);
};

export const authenticateApp = async (
  req: AuthenticateRequest,
  res: Response,
  next: Function
) => {
  try {
    const appOctokit = new MyOctokit({
      authStrategy: createAppAuth,
      auth: {
        id: process.env.GITHUB_APP_IDENTIFIER,
        privateKey: fs.readFileSync(
          resolve(__dirname, process.env.GITHUB_PRIVATE_KEY_PATH!),
          "utf8"
        ),
      },
    });

    const auth: any = await appOctokit.auth({ type: "app" });
    const token: string = auth!.token;
    req.appClient = new MyOctokit({ auth: token });
    next();
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
};

export const authenticateInstallation = async (
  req: AuthenticateRequest,
  res: Response,
  next: Function
) => {
  try {
    const { payload, appClient } = req;
    if (!payload["installation"]) {
      console.log("Payload without installation: ", req);
      return res.sendStatus(400);
    }
    const installationId = payload["installation"]["id"];
    if (!installationId) return res.sendStatus(400);
    if (
      (req.headers["x-github-event"] === "installation" ||
        req.headers["x-github-event"] === "integration_installation") &&
      payload["action"] === "deleted"
    )
      return next();
    const installationPayload = await appClient!.apps.createInstallationToken({
      installation_id: installationId,
    });
    const {
      data: { token },
    } = installationPayload;
    req.installationClient = new MyOctokit({ auth: token });
    req.installationToken = token;
    next();
  } catch (err) {
    console.error(err);
    res.sendStatus(200);
  }
};
