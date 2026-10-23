/** Lambda entry point (`index.handler` in dist/index.mjs), the user pool's pre sign-up trigger. */
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { cognitoPoolDirectory } from "./directory";
import { createPreSignUpHandler } from "./preSignUp";

// Built once per execution environment and reused across warm invocations. The pool ID comes
// from each event, so no configuration is needed.
export const handler = createPreSignUpHandler(
  cognitoPoolDirectory(new CognitoIdentityProviderClient({})),
);
