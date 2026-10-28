import type { Photo } from "@photo-app/shared";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { Api } from "@/api/api";
import { ApiRequestError } from "@/api/errors";
import { batches } from "./albums";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The trash (FR-DEL-3): own deleted photos, most recently deleted first. */
export const trashQuery = (api: Api) =>
  queryOptions({
    queryKey: ["trash"],
    queryFn: ({ signal }) => api.trash.list({ signal }),
  });

/** Whole days until the daily purge removes it, at least 1 while it is still there. */
export function daysLeft(photo: Photo, now = Date.now()): number {
  if (!photo.purgeAt) return 0;
  return Math.max(1, Math.ceil((Date.parse(photo.purgeAt) - now) / DAY_MS));
}

export interface TrashActionResult {
  /** Done, or already gone from the trash (404). */
  done: string[];
  /** Still in the trash, with the first error to show. */
  failed: string[];
  error?: unknown;
}

/**
 * Restore or delete forever, for several photos: one request per photo, a few at a time, like the
 * gallery's delete. Everything that shows photos, places or usage is refreshed afterwards.
 */
function useTrashAction(action: (api: Api, photoId: string) => Promise<unknown>) {
  const api = useRouteContext({ from: "__root__", select: (context) => context.api });
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (photoIds: string[]): Promise<TrashActionResult> => {
      const result: TrashActionResult = { done: [], failed: [] };
      for (const batch of batches(photoIds, 5)) {
        const settled = await Promise.allSettled(batch.map((id) => action(api, id)));
        settled.forEach((outcome, i) => {
          const photoId = batch[i]!;
          const gone =
            outcome.status === "fulfilled" ||
            (outcome.reason instanceof ApiRequestError && outcome.reason.code === "NOT_FOUND");
          if (gone) {
            result.done.push(photoId);
          } else {
            result.failed.push(photoId);
            result.error ??= outcome.reason;
          }
        });
      }
      return result;
    },
    onSettled: () => invalidateAfterTrash(queryClient),
  });
}

export const useRestorePhotos = () => useTrashAction((api, photoId) => api.trash.restore(photoId));

export const useDeleteForever = () =>
  useTrashAction((api, photoId) => api.trash.deleteForever(photoId));

export function useEmptyTrash() {
  const api = useRouteContext({ from: "__root__", select: (context) => context.api });
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.trash.empty(),
    onSettled: () => invalidateAfterTrash(queryClient),
  });
}

const invalidateAfterTrash = (queryClient: ReturnType<typeof useQueryClient>) =>
  Promise.all(
    [["trash"], ["photos"], ["albums"], ["places"], ["me"]].map((queryKey) =>
      queryClient.invalidateQueries({ queryKey }),
    ),
  );
