import { promisify } from "util";
import redis from "redis";

export const redisMasterClient = redis.createClient({
  host: "redis-master",
  port: 6379,
});
export const redisSlaveClient = redis.createClient({
  host: "redis-slave",
  port: 6379,
});

redisMasterClient.on("connect", () => console.log("Master connected."));
redisSlaveClient.on("connect", () => console.log("Slave connected."));
redisMasterClient.on("ready", () => console.log("Master ready."));
redisSlaveClient.on("ready", () => console.log("Slave ready."));
redisMasterClient.on("error", (err) => console.error(err));
redisSlaveClient.on("error", (err) => console.error(err));

export const setKey = promisify(redisMasterClient.set).bind(redisMasterClient);
export const getKey = promisify(redisSlaveClient.get).bind(redisSlaveClient);
export const deleteKeys = promisify(redisMasterClient.del).bind(
  redisMasterClient
);
export const deleteInstallation = promisify(redisMasterClient.flushall).bind(
  redisMasterClient
);
export const expireKey = promisify(redisMasterClient.expire).bind(
  redisMasterClient
);
