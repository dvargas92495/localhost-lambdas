#!/usr/bin/env node
import { Server } from "@hapi/hapi";
import { Headers } from "node-fetch";
import format from "date-fns/format";
import addSeconds from "date-fns/addSeconds";
import differenceInMilliseconds from "date-fns/differenceInMilliseconds";
import cuid from "cuid";
import fs from "fs";
import path from "path";
import type {
  APIGatewayProxyHandler,
  APIGatewayProxyResult,
  Handler,
} from "aws-lambda";
import ngrok from "ngrok";

const appPath = (p: string) => path.resolve(fs.realpathSync(process.cwd()), p);

const generateContext = ({
  functionName,
  executionTimeStarted,
}: {
  functionName: string;
  executionTimeStarted: Date;
}) => {
  const executionTimeout = addSeconds(executionTimeStarted, 10);
  return {
    awsRequestId: cuid(),
    callbackWaitsForEmptyEventLoop: true,
    clientContext: undefined,
    functionName,
    functionVersion: `$LATEST`,
    identity: undefined,
    invokedFunctionArn: `offline_invokedFunctionArn_for_${functionName}`,
    logGroupName: `offline_logGroupName_for_${functionName}`,
    logStreamName: `offline_logStreamName_for_${functionName}`,
    memoryLimitInMB: String(128),
    getRemainingTimeInMillis: () => {
      const timeLeft = differenceInMilliseconds(executionTimeout, new Date());
      return timeLeft > 0 ? timeLeft : 0;
    },
    // these three are deprecated
    done: () => ({}),
    fail: () => ({}),
    succeed: () => ({}),
  };
};

const run = async (props?: {
  disconnectRef?: { current?: () => void };
  port?: string;
  tunnel?: boolean | string;
}): Promise<void> => {
  process.env.NODE_ENV = "development";
  const port = Number(props?.port) || 3003;
  const functionNames = fs
    .readdirSync(appPath("lambdas"), { withFileTypes: true })
    .filter((f) => f.isFile())
    .map((f) => f.name.replace(/\.[t|j]s$/, ""));
  if (functionNames.length === 0) {
    console.error("No functions found");
    process.exit(1);
  }
  const functionHandlers = Object.fromEntries(
    functionNames
      .map((functionName) => ({
        path: appPath(`out/${functionName}.js`).replace(/\\/g, "/"),
        functionName,
      }))
      .map(({ path, functionName }) => [
        functionName,
        // hacky require to be ignored by webpack build
        eval(`require`)(path).handler,
      ])
  ) as { [key: string]: APIGatewayProxyHandler | Handler };

  const server = new Server({ port });
  // Consider registering dotenv

  functionNames.forEach((functionName) => {
    const [path, methodLower] = functionName.split("_");
    const routePath = `/dev/${path}`;
    if (methodLower) {
      const method = methodLower.toUpperCase();
      server.route({
        async handler(request, h) {
          const handler = functionHandlers[
            functionName
          ] as APIGatewayProxyHandler;
          if (typeof handler !== "function") {
            return h
              .response({
                errorMessage: `Could not find function handler for ${functionName}`,
                errorType: "HANDLER_NOT_FOUND",
              })
              .header("Content-Type", "application/json")
              .code(502);
          }
          const {
            headers,
            payload: rawPayload,
            params,
            info: { received, remoteAddress },
          } = request;
          const _headers = new Headers(headers);
          const encoding = _headers
            .get("content-type")
            ?.includes?.("multipart/form-data")
            ? "binary"
            : "utf8";
          const payload = rawPayload ? rawPayload.toString(encoding) : "{}";
          console.log(`Received Request ${method} ${path}`);
          const { url } = request.raw.req;
          const searchParams = Array.from(
            new URL(url || "", "http://example.com").searchParams.entries()
          );
          const event = {
            body: payload,
            headers: Object.fromEntries(_headers.entries()),
            httpMethod: method,
            isBase64Encoded: false, // TODO hook up
            multiValueHeaders: _headers.raw(),
            multiValueQueryStringParameters: searchParams.reduce(
              (prev, [k, v]) => {
                if (prev[k]) {
                  prev[k].push(v);
                } else {
                  prev[k] = [v];
                }
                return prev;
              },
              {} as { [k: string]: string[] }
            ),
            path,
            pathParameters: Object.keys(params).length ? params : null,
            queryStringParameters: Object.fromEntries(searchParams),
            requestContext: {
              accountId: "offlineContext_accountId",
              apiId: "offlineContext_apiId",
              authorizer: {},
              domainName: "offlineContext_domainName",
              domainPrefix: "offlineContext_domainPrefix",
              extendedRequestId: cuid(),
              httpMethod: method,
              identity: {
                accessKey: null,
                accountId:
                  process.env.SLS_ACCOUNT_ID || "offlineContext_accountId",
                apiKey: process.env.SLS_API_KEY || "offlineContext_apiKey",
                apiKeyId:
                  process.env.SLS_API_KEY_ID || "offlineContext_apiKeyId",
                caller: process.env.SLS_CALLER || "offlineContext_caller",
                clientCert: null,
                cognitoAuthenticationProvider:
                  _headers.get("cognito-authentication-provider") ||
                  process.env.SLS_COGNITO_AUTHENTICATION_PROVIDER ||
                  "offlineContext_cognitoAuthenticationProvider",
                cognitoAuthenticationType:
                  process.env.SLS_COGNITO_AUTHENTICATION_TYPE ||
                  "offlineContext_cognitoAuthenticationType",
                cognitoIdentityId:
                  _headers.get("cognito-identity-id") ||
                  process.env.SLS_COGNITO_IDENTITY_ID ||
                  "offlineContext_cognitoIdentityId",
                cognitoIdentityPoolId:
                  process.env.SLS_COGNITO_IDENTITY_POOL_ID ||
                  "offlineContext_cognitoIdentityPoolId",
                principalOrgId: null,
                sourceIp: remoteAddress,
                user: "offlineContext_user",
                userAgent: _headers.get("user-agent") || "",
                userArn: "offlineContext_userArn",
              },
              path,
              protocol: "HTTP/1.1",
              requestId: cuid(),
              requestTime: format(
                new Date(received),
                "dd/MMM/yyyy:HH:mm:ss zzz"
              ),
              requestTimeEpoch: received,
              resourceId: "offlineContext_resourceId",
              resourcePath: path,
              stage: "dev",
            },
            resource: path,
            stageVariables: null,
          };
          const executionTimeStarted = new Date();
          const context = generateContext({
            functionName,
            executionTimeStarted,
          });

          const result = handler(event, context, () => ({}));
          return (result || Promise.resolve())
            .then((result: APIGatewayProxyResult | void) => {
              const executionTime = differenceInMilliseconds(
                new Date(),
                executionTimeStarted
              );
              console.log(
                `Executed ${method} ${functionName} in ${executionTime}ms`
              );
              return result;
            })
            .then((result) => {
              if (!result || typeof result.body !== "string") {
                return h
                  .response({
                    errorMessage: "Invalid body returned",
                    errorType: "INVALID_BODY",
                  })
                  .header("Content-Type", "application/json")
                  .code(502);
              }
              const response = result.isBase64Encoded
                ? h
                    .response(Buffer.from(result.body, "base64"))
                    .encoding("binary")
                : h.response(result.body);
              Object.entries(result.headers || {}).forEach(([k, v]) =>
                response.header(k, v.toString(), { append: true })
              );
              Object.entries(result.multiValueHeaders || {}).forEach(
                ([k, vs]) =>
                  vs.forEach((v) =>
                    response.header(k, v.toString(), { append: true })
                  )
              );
              response.code(result.statusCode || 200);
              return response;
            })
            .catch((error: Error) => {
              const message = error.message || error.toString();
              console.error(message, "\n", error);
              return h
                .response({
                  errorMessage: message,
                  errorType: error.constructor.name,
                  stackTrace: (error.stack || "")
                    .split("\n")
                    .map((l) => l.trim()),
                })
                .header("Content-Type", "application/json")
                .code(502);
            });
        },
        method,
        options: {
          ...(["HEAD", "GET"].includes(method)
            ? {}
            : {
                payload: {
                  maxBytes: 1024 * 1024 * 10,
                  parse: false,
                },
              }),
          state: {
            failAction: "error",
            parse: true,
          },
          cors: true,
          tags: ["api"],
          timeout: { socket: false },
        },
        path: routePath,
      });
    } else {
      server.route({
        async handler(request, h) {
          const handler = functionHandlers[functionName] as Handler<
            Record<string, unknown>,
            void
          >;
          if (typeof handler !== "function") {
            return h
              .response({
                errorMessage: `Could not find function handler for ${functionName}`,
                errorType: "HANDLER_NOT_FOUND",
              })
              .header("Content-Type", "application/json")
              .code(502);
          }
          const { payload } = request;
          const event = JSON.parse(payload.toString("utf-8"));
          console.log(`Received Request async ${path}`);
          const executionTimeStarted = new Date();
          const context = generateContext({
            functionName,
            executionTimeStarted,
          });
          new Promise((resolve) =>
            setTimeout(() => resolve(handler(event, context, () => ({}))), 1)
          )
            .then(() => {
              const executionTime = differenceInMilliseconds(
                new Date(),
                executionTimeStarted
              );
              console.log(
                `Executed async ${functionName} in ${executionTime}ms`
              );
            })
            .catch((error: Error) => {
              const message = error.message || error.toString();
              console.error(message, "\n", error);
            });
          return h.response().code(202);
        },
        method: "POST",
        options: {
          payload: {
            maxBytes: 1024 * 1024 * 10,
            parse: false,
          },
          state: {
            failAction: "error",
            parse: true,
          },
          tags: ["async"],
          timeout: { socket: false },
        },
        path: routePath,
      });
    }
  });

  // CORS OPTIONS
  Array.from(
    new Set(
      functionNames
        .map((f) => f.split("_"))
        .filter((s) => s.length > 1)
        .map((s) => s[0])
    )
  ).forEach((path) =>
    server.route({
      handler(request, h) {
        return h
          .response()
          .code(200)
          .header(
            "Access-Control-Allow-Headers",
            request.headers["access-control-request-headers"]
          )
          .header("Access-Control-Allow-Origin", request.headers["origin"])
          .header(
            "Access-Control-Allow-Methods",
            request.headers["access-control-request-method"]
          );
      },
      method: "OPTIONS",
      options: {
        tags: ["api"],
      },
      path: `/dev/${path}`,
    })
  );

  server.route({
    handler(request, h) {
      const response = h
        .response({
          currentRoute: `${request.method} - ${request.path}`,
          error: "Route not found.",
          existingRoutes: server
            .table()
            .filter((route) => route.path !== "/{p*}")
            .sort((a, b) => (a.path <= b.path ? -1 : 1))
            .map((route) => `${route.method} - ${route.path}`),
          statusCode: 404,
        })
        .code(404);

      return response;
    },
    method: "*",
    options: {
      cors: true,
    },
    path: "/{p*}",
  });

  return server
    .start()
    .then(() => {
      console.log(`Listening on https://localhost:${port}. Functions:`);
      console.log(
        server
          .table()
          .filter((route) => route.path !== "/{p*}")
          .sort((a, b) => (a.path <= b.path ? -1 : 1))
          .map((route) => `    ${route.method.toUpperCase()} - ${route.path}`)
          .join("\n")
      );
      if (props?.tunnel) {
        return ngrok
          .connect({
            addr: port,
            subdomain:
              typeof props.tunnel === "string"
                ? props.tunnel
                : path.basename(process.cwd()),
          })
          .then((url) => {
            console.log("Started local ngrok tunneling:");
            console.log(url);
          });
      }
      return Promise.resolve();
    })
    .then(() => {
      if (props?.disconnectRef) {
        props.disconnectRef.current = () => {
          server.stop();
          if (props?.tunnel) {
            ngrok.kill();
          }
        };
      }
    });
};

if (process.env.NODE_ENV !== "test") {
  const [, , ...args] = process.argv;
  const port = args.find((_, i, all) => all[i - 1] === "--port");
  const tunnelIndex = args.findIndex((a) => a === "--tunnel");
  run({
    port,
    tunnel: tunnelIndex >= 0 && (args[tunnelIndex + 1] || true),
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export default run;
