import { Octokit } from "@octokit/rest";
import { google } from "@google-cloud/cloudbuild/build/protos/protos";
import { Request } from "express";

export type { Response } from "express";

export type Build = google.devtools.cloudbuild.v1.IBuild;
export type BuildStep = google.devtools.cloudbuild.v1.BuildStep;

export interface Branch {
  [key: string]: any;
  sha: string;
  ref: string;
  repo: {
    [key: string]: any;
    name: string;
  };
}

export interface PullRequest {
  [key: string]: any;
  id: number;
  number: number;
  base: Branch;
  head: Branch;
}

export interface Repository {
  [key: string]: any;
  full_name: string;
  name: string;
  owner?: {
    [key: string]: any;
  };
}

export interface RepoStatus {
  completed?: boolean;
  configJson?: Build;
  bucket?: string;
  bucketObject?: string;
  triggered?: boolean;
  build?: Build;
  cloudBuild?: any;
  stepLines?: number[];
  yamlFile?: string;
  fetched?: boolean;
  merged?: boolean;
  tarCreated?: boolean;
  uploaded?: boolean;
}

export interface Payload {
  [key: string]: any;
  repository?: Repository;
  pull_request?: PullRequest;
  check_run?: {
    [key: string]: any;
    name: string;
    id: number;
    check_suite: {
      [key: string]: any;
      id: number;
      pull_requests: PullRequest[];
    };
  };
  action: string;
  installation?: {
    id: number;
    [key: string]: any;
  };
  repositories_added?: Array<Repository>;
}

export interface AuthenticateRequest extends Request {
  payload?: Payload | any;
  installationClient?: Octokit;
  installationToken?: string;
  appClient?: Octokit;
}

export interface GoogleTimeObject {
  seconds: number;
  nanos: number;
}

export interface FinishedStep extends google.devtools.cloudbuild.v1.BuildStep {
  timing: {
    startTime: GoogleTimeObject;
    endTime: GoogleTimeObject;
  };
}

export interface FinishedBuild extends google.devtools.cloudbuild.v1.Build {
  createTime: GoogleTimeObject;
  startTime: GoogleTimeObject;
  finishTime: GoogleTimeObject;
  steps: FinishedStep[];
  results: {
    images: Array<{ name: string }>;
  };
}

export interface ResponseError extends Error {
  status?: number;
}
