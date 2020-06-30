import express from "express";
import { Request, Response } from "express";
import bodyParser from "body-parser";
import eventHandler from "./Main";
import { ResponseError } from "./Interfaces";
import {
  verifyPayload,
  authenticateApp,
  authenticateInstallation,
} from "./Middlewares";

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.post(
  "/",
  verifyPayload,
  authenticateApp,
  authenticateInstallation,
  eventHandler
);

app.use((err: ResponseError, req: Request, res: Response, next: Function) => {
  console.error(err);
  res.locals.message = err.message;
  res.locals.error = process.env.MODE === "development" ? err : {};
  return res.status(err.status || 500);
});

app.listen(5001, () => console.log("Listening on port 5001..."));
