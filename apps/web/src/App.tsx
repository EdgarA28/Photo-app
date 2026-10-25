import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import type { AppConfig } from "./config";
import { ConfigProvider } from "./configContext";
import { UpdatePrompt } from "./pwa/UpdatePrompt";
import type { createAppRouter } from "./router";

export function App({
  config,
  queryClient,
  router,
}: {
  config: AppConfig;
  queryClient: QueryClient;
  router: ReturnType<typeof createAppRouter>;
}) {
  return (
    <ConfigProvider value={config}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        {/* Outside the router: also on the login and error pages (9.4). */}
        <UpdatePrompt />
      </QueryClientProvider>
    </ConfigProvider>
  );
}
