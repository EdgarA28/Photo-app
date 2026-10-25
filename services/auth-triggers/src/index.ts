/** Lambda entry point (`index.handler` in dist/index.mjs), the user pool's pre sign-up trigger. */
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { cognitoPoolDirectory } from "./directory";
import { createPreSignUpHandler, parseAllowedEmails } from "./preSignUp";

// Built once per execution environment and reused across warm invocations. The pool ID comes
// from each event; `ALLOWED_EMAILS` is the only configuration (set by infra, optional).
export const handler = createPreSignUpHandler(
  cognitoPoolDirectory(new CognitoIdentityProviderClient({})),
  { allowedEmails: parseAllowedEmails(process.env.ALLOWED_EMAILS) },
);
