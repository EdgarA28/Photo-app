import { createContext, useContext } from "react";
import type { AppConfig } from "./config";

const ConfigContext = createContext<AppConfig | null>(null);

export const ConfigProvider = ConfigContext.Provider;

export function useConfig(): AppConfig {
  const config = useContext(ConfigContext);
  if (!config) throw new Error("useConfig outside ConfigProvider");
  return config;
}
