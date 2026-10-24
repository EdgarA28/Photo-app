import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const env = {
  VITE_COGNITO_USER_POOL_ID: "us-east-1_vYJcHEj4G",
  VITE_COGNITO_CLIENT_ID: "jkfonk4j32kup18bl98jqkr67",
  VITE_COGNITO_DOMAIN: "https://photo-app-dev-063359189013.auth.us-east-1.amazoncognito.com/",
  VITE_GOOGLE_LOGIN: "true",
};

describe("loadConfig", () => {
  it("derives the issuer from the pool and normalises the domain", () => {
    expect(loadConfig(env, "http://localhost:5173")).toEqual({
      origin: "http://localhost:5173",
      cognito: {
        issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_vYJcHEj4G",
        clientId: "jkfonk4j32kup18bl98jqkr67",
        domain: "https://photo-app-dev-063359189013.auth.us-east-1.amazoncognito.com",
      },
      googleLogin: true,
    });
  });

  it("turns Google off unless enabled", () => {
    const { VITE_GOOGLE_LOGIN: _, ...rest } = env;
    expect(loadConfig(rest, "http://localhost:5173").googleLogin).toBe(false);
  });

  it.each([
    ["missing client", { VITE_COGNITO_CLIENT_ID: undefined }],
    ["bad pool id", { VITE_COGNITO_USER_POOL_ID: "vYJcHEj4G" }],
    ["http domain", { VITE_COGNITO_DOMAIN: "http://example.com" }],
  ])("rejects %s", (_, override) => {
    expect(() => loadConfig({ ...env, ...override }, "http://localhost:5173")).toThrow(
      /Invalid app configuration/,
    );
  });
});
