import { isFinalImportStatus, type Import } from "@photo-app/shared";
import { queryOptions } from "@tanstack/react-query";
import type { Api } from "@/api/api";

/** How often an import's progress is read while it runs (the API asks Google at most this often). */
export const IMPORT_POLL_MS = 3000;

/** One import's progress (FR-IMP-5), polled until it ends. */
export const importQuery = (api: Api, importId: string) =>
  queryOptions({
    queryKey: ["imports", importId],
    queryFn: ({ signal }) => api.imports.get(importId, { signal }),
    refetchInterval: (query) => {
      const data: Import | undefined = query.state.data;
      return data && isFinalImportStatus(data.status) ? false : IMPORT_POLL_MS;
    },
    // Keeps polling while the user picks in the other window or app.
    refetchIntervalInBackground: true,
  });
