/** Lambda entry point (`index.handler` in dist/index.mjs), invoked by the API Gateway HTTP API. */
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { S3Client } from "@aws-sdk/client-s3";
import { SSMClient } from "@aws-sdk/client-ssm";
import { handle } from "@hono/aws-lambda";
import { createApp } from "./app";
import { loadConfig } from "./lib/config";
import { cloudFrontMediaSigner, ssmPrivateKeyLoader } from "./lib/media";
import { s3PhotoStorage } from "./lib/storage";
import { cognitoUserDirectory } from "./lib/users";
import { createDocumentClient, createRepositories } from "./repo";
import { registerPublicRoutes, registerRoutes } from "./routes";

// Built once per execution environment and reused across warm invocations. A missing environment
// variable fails the cold start rather than a request.
const config = loadConfig();
const repos = createRepositories({ client: createDocumentClient(), table: config.tableName });
const users = cognitoUserDirectory(new CognitoIdentityProviderClient({}), config.userPoolId);
const storage = s3PhotoStorage(new S3Client({}), config.photoBucket);
const media = cloudFrontMediaSigner({
  origin: config.mediaOrigin,
  keyPairId: config.mediaKeyPairId,
  loadPrivateKey: ssmPrivateKeyLoader(new SSMClient({}), config.mediaPrivateKeyParameter),
});

const deps = { repos, users, storage, media, config };
export const handler = handle(
  createApp({ routes: registerRoutes(deps), publicRoutes: registerPublicRoutes(deps) }),
);
