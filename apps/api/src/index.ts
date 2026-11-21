/** Lambda entry point (`index.handler` in dist/index.mjs), invoked by the API Gateway HTTP API. */
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { SQSClient } from "@aws-sdk/client-sqs";
import { SSMClient } from "@aws-sdk/client-ssm";
import { handle } from "@hono/aws-lambda";
import { createApp } from "./app";
import { loadConfig, loadImportConfig } from "./lib/config";
import { googlePhotosClient } from "./lib/google";
import { sqsImportQueue } from "./lib/importQueue";
import { cloudFrontMediaSigner, ssmPrivateKeyLoader } from "./lib/media";
import { createS3Client, s3PhotoStorage } from "./lib/storage";
import { cognitoUserDirectory } from "./lib/users";
import { createDocumentClient, createRepositories } from "./repo";
import { registerPublicRoutes, registerRoutes } from "./routes";

// Built once per execution environment and reused across warm invocations. A missing environment
// variable fails the cold start rather than a request.
const config = loadConfig();
const repos = createRepositories({ client: createDocumentClient(), table: config.tableName });
const users = cognitoUserDirectory(new CognitoIdentityProviderClient({}), config.userPoolId);
const storage = s3PhotoStorage(createS3Client(), config.photoBucket);

const ssm = new SSMClient({});
const media = cloudFrontMediaSigner({
  origin: config.mediaOrigin,
  keyPairId: config.mediaKeyPairId,
  loadPrivateKey: ssmPrivateKeyLoader(ssm, config.mediaPrivateKeyParameter),
});
// Import from Google Photos (13.5c): only once the infra sets it up (13.5f).
const importConfig = loadImportConfig();
const imports = importConfig && {
  google: googlePhotosClient({
    clientId: importConfig.googleClientId,
    // Same cached SSM read as the media key; the secret stays in memory only (NFR-SEC-10).
    loadClientSecret: ssmPrivateKeyLoader(ssm, importConfig.googleClientSecretParameter),
  }),
  queue: sqsImportQueue(new SQSClient({}), importConfig.importQueueUrl),
  redirectOrigins: importConfig.redirectOrigins,
};

const deps = { repos, users, storage, media, config, ...(imports && { imports }) };
export const handler = handle(
  createApp({ routes: registerRoutes(deps), publicRoutes: registerPublicRoutes(deps) }),
);
